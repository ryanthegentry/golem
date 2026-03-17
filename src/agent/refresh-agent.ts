import type { ExtendedVirtualCoin } from '@arkade-os/sdk';
import type { GolemWallet } from '../wallet/golem-wallet.js';
import { DEFAULT_RESERVE_PER_VTXO, DEFAULT_EXIT_THRESHOLD_BLOCKS } from '../config/defaults.js';
import { isBlockHeight, getNearestExpiryMs, blockHeightToRemainingMs, BlockHeightFetcher } from './expiry.js';

interface RefreshAgentConfig {
  /** How often to check for expiring VTXOs (ms). Default: 60_000 (1 min) */
  pollIntervalMs: number;
  /**
   * Refresh VTXOs when this much time remains before expiry (ms). Default: 3 days.
   *
   * For block-height-based expiries (mutinynet/regtest), converted to approximate
   * wall-clock time using current block height from esplora + 10 min avg block time.
   */
  safetyMarginMs: number;
  /** Max VTXOs before triggering proactive consolidation. Default: 10 */
  maxVtxoCount: number;
  /** VTXOs below this amount (sats) are considered dust. Default: 1000 */
  dustThresholdSats: number;
  /** On-chain Bitcoin address for emergency exit. If not set, emergency exit is disabled. */
  safeHarborAddress?: string;
  /** Blocks before VTXO expiry at which emergency exit triggers. Default: 432 (~72 hours). */
  safeHarborExitThresholdBlocks: number;
  /** Esplora API URL for block height fetching. Required for block-height-based expiry networks. */
  esploraUrl?: string;
}

interface EmergencyState {
  consecutiveRefreshFailures: number;
  lastSuccessfulRefresh: Date | null;
  emergencyExitAttempted: boolean;
  emergencyExitCompleted: boolean;
}

export const DEFAULT_REFRESH_CONFIG: RefreshAgentConfig = {
  pollIntervalMs: 60_000,
  safetyMarginMs: 3 * 24 * 60 * 60 * 1000, // 3 days
  maxVtxoCount: 10,
  dustThresholdSats: 1000,
  safeHarborExitThresholdBlocks: DEFAULT_EXIT_THRESHOLD_BLOCKS,
};

export type RefreshEvent =
  | { type: 'check'; expiringCount: number; vtxoCount: number; dustCount: number; nearestExpiryMs: number | null; totalBalanceSats: number; timestamp: string }
  | { type: 'refresh_start'; vtxoCount: number; timestamp: string }
  | { type: 'refresh_ok'; txid: string; timestamp: string }
  | { type: 'refresh_error'; error: string; timestamp: string }
  | { type: 'consolidation_start'; vtxoCount: number; totalSats: number; timestamp: string }
  | { type: 'consolidation_ok'; txid: string; inputCount: number; timestamp: string }
  | { type: 'consolidation_error'; error: string; timestamp: string }
  | { type: 'consolidation_skip'; reason: string; timestamp: string }
  | { type: 'reserve_low'; actual: number; required: number; vtxoCount: number; timestamp: string }
  | { type: 'emergency_exit_triggered'; reason: string; timestamp: string }
  | { type: 'emergency_exit_completed'; txid: string; method: 'offboard' | 'unroll'; timestamp: string }
  | { type: 'emergency_exit_failed'; error: string; timestamp: string }
  | { type: 'stopped'; timestamp: string };

/** Distributive Omit that preserves discriminated union members. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type RefreshEventHandler = (event: RefreshEvent) => void;

/**
 * Automated VTXO refresh agent.
 *
 * Polls for expiring VTXOs and renews them before the safety margin.
 * This is the core automation that prevents users from losing bitcoin
 * due to expired timelocks.
 */
export class RefreshAgent {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly emergency: EmergencyState = {
    consecutiveRefreshFailures: 0,
    lastSuccessfulRefresh: null,
    emergencyExitAttempted: false,
    emergencyExitCompleted: false,
  };
  private readonly blockHeightFetcher: BlockHeightFetcher | null;
  /** Current backoff multiplier for exponential backoff on consecutive errors. */
  private backoffMultiplier = 1;
  private static readonly MAX_BACKOFF_MULTIPLIER = 10; // max 10x poll interval (10 min at 60s base)
  private static readonly BACKOFF_GROWTH = 2;

  constructor(
    private readonly wallet: GolemWallet,
    private readonly config: RefreshAgentConfig = DEFAULT_REFRESH_CONFIG,
    private readonly onEvent?: RefreshEventHandler,
    private readonly gateway?: { shutdown(): void },
  ) {
    this.blockHeightFetcher = config.esploraUrl
      ? new BlockHeightFetcher(config.esploraUrl)
      : null;
  }

  /** Start the polling loop (uses setTimeout chain for adaptive backoff) */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.backoffMultiplier = 1;
    // Run immediately, then schedule next
    void this.tickAndSchedule();
  }

  /** Stop the polling loop */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit({ type: 'stopped' });
  }

  /** Run one tick then schedule the next with adaptive delay. */
  private async tickAndSchedule(): Promise<void> {
    if (!this.running) return;
    const hadError = await this.tick();
    if (!this.running) return;

    if (hadError) {
      this.backoffMultiplier = Math.min(
        this.backoffMultiplier * RefreshAgent.BACKOFF_GROWTH,
        RefreshAgent.MAX_BACKOFF_MULTIPLIER,
      );
    } else {
      this.backoffMultiplier = 1;
    }

    const delay = Math.round(this.config.pollIntervalMs * this.backoffMultiplier);
    this.timer = setTimeout(() => void this.tickAndSchedule(), delay);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Run a single check-and-refresh cycle (public for testing). Returns true if an error occurred. */
  async tick(): Promise<boolean> {
    // If emergency exit already completed, do nothing
    if (this.emergency.emergencyExitCompleted) return false;

    let refreshed = false;

    try {
      const expiring = await this.wallet.getExpiringVtxos(this.config.safetyMarginMs);
      const allVtxos = await this.wallet.getVtxos();
      const spendable = allVtxos.filter(v =>
        v.virtualStatus?.state === 'settled' || v.virtualStatus?.state === 'preconfirmed'
      );
      const dustCount = spendable.filter(v => v.value < this.config.dustThresholdSats).length;

      // Fetch current block height for block-height-based expiry conversion
      const currentBlockHeight = this.blockHeightFetcher
        ? await this.blockHeightFetcher.getBlockHeight() ?? undefined
        : undefined;

      // Compute nearest expiry across all VTXOs (ms remaining, or null if none)
      const nearestExpiryMs = getNearestExpiryMs(
        allVtxos.map(v => ({ batchExpiry: v.virtualStatus?.batchExpiry ?? 0 })),
        currentBlockHeight,
      );

      // Compute total balance from spendable VTXOs (avoids extra SDK call)
      const totalBalanceSats = spendable.reduce((sum, v) => sum + v.value, 0);

      this.emit({
        type: 'check',
        expiringCount: expiring.length,
        vtxoCount: spendable.length,
        dustCount,
        nearestExpiryMs,
        totalBalanceSats,
      });

      // Reserve monitoring — warn if on-chain reserve is low
      await this.checkReserve(spendable.length);

      // Emergency exit check — block-based threshold
      if (this.config.safeHarborAddress && allVtxos.length > 0) {
        const shouldExit = this.shouldEmergencyExit(allVtxos, currentBlockHeight);
        if (shouldExit && this.emergency.consecutiveRefreshFailures > 0) {
          await this.attemptEmergencyExit();
          return false;
        }
      }

      if (expiring.length > 0) {
        this.emit({
          type: 'refresh_start',
          vtxoCount: expiring.length,
        });

        const txid = await this.wallet.renewVtxos();
        refreshed = true;
        this.emergency.consecutiveRefreshFailures = 0;
        this.emergency.lastSuccessfulRefresh = new Date();

        this.emit({
          type: 'refresh_ok',
          txid,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emergency.consecutiveRefreshFailures++;
      this.emit({
        type: 'refresh_error',
        error: message,
      });
      return true; // Error occurred — caller should back off
    }

    // Consolidation: only when no refresh happened this tick
    if (refreshed) return false;

    try {
      const consolidation = await this.shouldConsolidate();
      if (!consolidation.needed) {
        this.emit({
          type: 'consolidation_skip',
          reason: 'not needed',
        });
        return false;
      }

      const candidates = consolidation.candidates!;
      const totalSats = candidates.reduce((sum, v) => sum + v.value, 0);

      this.emit({
        type: 'consolidation_start',
        vtxoCount: candidates.length,
        totalSats,
      });

      const txid = await this.wallet.consolidateVtxos(candidates);

      this.emit({
        type: 'consolidation_ok',
        txid,
        inputCount: candidates.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: 'consolidation_error',
        error: message,
      });
    }

    return false;
  }

  /**
   * Check if the closest VTXO expiry is within the emergency exit threshold (block-based).
   *
   * Handles both block-height expiries (mutinynet/regtest) and timestamp expiries (mainnet).
   * For block-height expiries, compares directly against current block height.
   * For timestamp expiries, converts threshold blocks to ms using 10 min/block.
   */
  private shouldEmergencyExit(vtxos: ExtendedVirtualCoin[], currentBlockHeight?: number): boolean {
    const threshold = this.config.safeHarborExitThresholdBlocks;

    for (const vtxo of vtxos) {
      const expiry = vtxo.virtualStatus.batchExpiry;
      if (!expiry || expiry <= 0) continue;

      if (isBlockHeight(expiry)) {
        // Block-height expiry — compare directly using current block height
        if (currentBlockHeight !== undefined) {
          const blocksRemaining = expiry - currentBlockHeight;
          if (blocksRemaining > 0 && blocksRemaining < threshold) {
            return true;
          }
        }
        // If no block height available, fall through — can't evaluate
        continue;
      }

      // Timestamp-based expiry — convert threshold blocks to ms (10 min/block for mainnet)
      const thresholdMs = threshold * 10 * 60 * 1000;
      const remainingMs = expiry - Date.now();
      if (remainingMs > 0 && remainingMs < thresholdMs) {
        return true;
      }
    }

    return false;
  }

  /** Check on-chain reserve balance against VTXO count requirement. */
  private async checkReserve(vtxoCount: number): Promise<void> {
    if (vtxoCount === 0) return;

    try {
      const reserve = await this.wallet.getOnchainReserveBalance();
      const required = vtxoCount * DEFAULT_RESERVE_PER_VTXO;

      if (reserve < required) {
        this.emit({
          type: 'reserve_low',
          actual: reserve,
          required,
          vtxoCount,
        });
      }
    } catch {
      // OnchainWallet may not be funded yet — don't block on this
    }
  }

  /** Attempt emergency exit to safe harbor address. */
  private async attemptEmergencyExit(): Promise<void> {
    const address = this.config.safeHarborAddress;
    if (!address) return;

    this.emergency.emergencyExitAttempted = true;

    this.emit({
      type: 'emergency_exit_triggered',
      reason: `VTXOs approaching expiry, ${this.emergency.consecutiveRefreshFailures} consecutive refresh failures`,
    });

    try {
      const result = await this.wallet.exitToSafeHarbor(address, this.gateway);

      this.emergency.emergencyExitCompleted = true;
      this.emit({
        type: 'emergency_exit_completed',
        txid: result.txid,
        method: result.method,
      });

      this.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: 'emergency_exit_failed',
        error: message,
      });
      // Keep running — will retry next tick
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

  private emit(event: DistributiveOmit<RefreshEvent, 'timestamp'>): void {
    this.onEvent?.({ ...event, timestamp: new Date().toISOString() } as RefreshEvent);
  }
}
