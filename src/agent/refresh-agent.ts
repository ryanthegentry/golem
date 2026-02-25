import type { ExtendedVirtualCoin } from '@arkade-os/sdk';
import type { GolemWallet } from '../wallet/golem-wallet.js';

export interface RefreshAgentConfig {
  /** How often to check for expiring VTXOs (ms). Default: 60_000 (1 min) */
  pollIntervalMs: number;
  /**
   * Refresh VTXOs when this much time remains before expiry (ms). Default: 3 days.
   *
   * This is passed through to the SDK's VtxoManager.getExpiringVtxos() as thresholdMs.
   * The SDK compares it against (batchExpiry - Date.now()) where batchExpiry is stored
   * in milliseconds.
   *
   * IMPORTANT — batchExpiry semantics vary by network:
   *   - Mainnet/liquid: batchExpiry = Unix ms (server returns expiresAt in seconds,
   *     SDK indexer multiplies by 1000).
   *   - Regtest/mutinynet: the server may return raw block heights instead of timestamps
   *     for expiresAt. The SDK has a heuristic workaround in isExpired() that treats
   *     values before year 2025 as block heights and ignores them. The isVtxoExpiringSoon()
   *     function does NOT have this guard — it will compare block heights against Date.now()
   *     and produce nonsensical results.
   *
   * TODO (Step 6): When building dynamic safety margins, we need to:
   *   1. Detect whether batchExpiry is a timestamp or block height (check if < 1e12)
   *   2. For block heights: convert to estimated wall-clock time using
   *      currentBlockHeight + avgBlockInterval from the esplora API
   *   3. Consider the SDK's own isExpired() heuristic (year < 2025 = block height)
   *   See src/agent/expiry.ts for the conversion stub.
   */
  safetyMarginMs: number;
  /** Max VTXOs before triggering proactive consolidation. Default: 10 */
  maxVtxoCount: number;
  /** VTXOs below this amount (sats) are considered dust. Default: 1000 */
  dustThresholdSats: number;
}

export const DEFAULT_REFRESH_CONFIG: RefreshAgentConfig = {
  pollIntervalMs: 60_000,
  safetyMarginMs: 3 * 24 * 60 * 60 * 1000, // 3 days
  maxVtxoCount: 10,
  dustThresholdSats: 1000,
};

export type RefreshEvent =
  | { type: 'check'; expiringCount: number; vtxoCount: number; dustCount: number; timestamp: string }
  | { type: 'refresh_start'; vtxoCount: number; timestamp: string }
  | { type: 'refresh_ok'; txid: string; timestamp: string }
  | { type: 'refresh_error'; error: string; timestamp: string }
  | { type: 'consolidation_start'; vtxoCount: number; totalSats: number; timestamp: string }
  | { type: 'consolidation_ok'; txid: string; inputCount: number; timestamp: string }
  | { type: 'consolidation_skip'; reason: string; timestamp: string }
  | { type: 'stopped'; timestamp: string };

export type RefreshEventHandler = (event: RefreshEvent) => void;

/**
 * Automated VTXO refresh agent.
 *
 * Polls for expiring VTXOs and renews them before the safety margin.
 * This is the core automation that prevents users from losing bitcoin
 * due to expired timelocks.
 */
export class RefreshAgent {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly wallet: GolemWallet,
    private readonly config: RefreshAgentConfig = DEFAULT_REFRESH_CONFIG,
    private readonly onEvent?: RefreshEventHandler,
  ) {}

  /** Start the polling loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    // Run immediately, then on interval
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
  }

  /** Stop the polling loop */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit({ type: 'stopped', timestamp: new Date().toISOString() });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Run a single check-and-refresh cycle (public for testing) */
  async tick(): Promise<void> {
    let refreshed = false;

    try {
      const expiring = await this.wallet.getExpiringVtxos(this.config.safetyMarginMs);
      const allVtxos = await this.wallet.getVtxos();
      const spendable = allVtxos.filter(v =>
        v.virtualStatus?.state === 'settled' || v.virtualStatus?.state === 'preconfirmed'
      );
      const dustCount = spendable.filter(v => v.value < this.config.dustThresholdSats).length;

      this.emit({
        type: 'check',
        expiringCount: expiring.length,
        vtxoCount: spendable.length,
        dustCount,
        timestamp: new Date().toISOString(),
      });

      if (expiring.length > 0) {
        this.emit({
          type: 'refresh_start',
          vtxoCount: expiring.length,
          timestamp: new Date().toISOString(),
        });

        const txid = await this.wallet.renewVtxos();
        refreshed = true;

        this.emit({
          type: 'refresh_ok',
          txid,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: 'refresh_error',
        error: message,
        timestamp: new Date().toISOString(),
      });
      return; // Don't attempt consolidation after an error
    }

    // Consolidation: only when no refresh happened this tick
    if (refreshed) return;

    try {
      const consolidation = await this.shouldConsolidate();
      if (!consolidation.needed) {
        this.emit({
          type: 'consolidation_skip',
          reason: 'not needed',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const candidates = consolidation.candidates!;
      const totalSats = candidates.reduce((sum, v) => sum + v.value, 0);

      this.emit({
        type: 'consolidation_start',
        vtxoCount: candidates.length,
        totalSats,
        timestamp: new Date().toISOString(),
      });

      const txid = await this.wallet.consolidateVtxos(candidates);

      this.emit({
        type: 'consolidation_ok',
        txid,
        inputCount: candidates.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: 'refresh_error',
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async shouldConsolidate(): Promise<{
    needed: boolean;
    reason?: string;
    candidates?: ExtendedVirtualCoin[];
  }> {
    const allVtxos = await this.wallet.getVtxos();
    const spendable = allVtxos.filter(v =>
      v.virtualStatus?.state === 'settled' || v.virtualStatus?.state === 'preconfirmed'
    );

    // Need at least 2 VTXOs to consolidate
    if (spendable.length < 2) return { needed: false };

    // Trigger 1: Too many VTXOs
    if (spendable.length > this.config.maxVtxoCount) {
      return { needed: true, reason: 'fragmented', candidates: spendable };
    }

    // Trigger 2: Dust VTXOs exist
    const dustVtxos = spendable.filter(v => v.value < this.config.dustThresholdSats);
    if (dustVtxos.length > 0) {
      return { needed: true, reason: 'dust', candidates: spendable };
    }

    return { needed: false };
  }

  private emit(event: RefreshEvent): void {
    this.onEvent?.(event);
  }
}
