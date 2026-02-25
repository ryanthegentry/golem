import type { GolemWallet } from '../wallet/golem-wallet.js';

export interface RefreshAgentConfig {
  /** How often to check for expiring VTXOs (ms). Default: 60_000 (1 min) */
  pollIntervalMs: number;
  /** Refresh VTXOs when this much time remains before expiry (ms). Default: 3 days */
  safetyMarginMs: number;
}

export const DEFAULT_REFRESH_CONFIG: RefreshAgentConfig = {
  pollIntervalMs: 60_000,
  safetyMarginMs: 3 * 24 * 60 * 60 * 1000, // 3 days
};

export type RefreshEvent =
  | { type: 'check'; expiringCount: number; timestamp: string }
  | { type: 'refresh_start'; vtxoCount: number; timestamp: string }
  | { type: 'refresh_ok'; txid: string; timestamp: string }
  | { type: 'refresh_error'; error: string; timestamp: string }
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
    try {
      const expiring = await this.wallet.getExpiringVtxos();

      this.emit({
        type: 'check',
        expiringCount: expiring.length,
        timestamp: new Date().toISOString(),
      });

      if (expiring.length === 0) return;

      this.emit({
        type: 'refresh_start',
        vtxoCount: expiring.length,
        timestamp: new Date().toISOString(),
      });

      const txid = await this.wallet.renewVtxos();

      this.emit({
        type: 'refresh_ok',
        txid,
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

  private emit(event: RefreshEvent): void {
    this.onEvent?.(event);
  }
}
