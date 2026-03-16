import type { SweepConfig, SweepEvent } from './types.js';
import { detectAddressType, resolveToInvoice } from './address-resolver.js';

/** Distributive Omit that preserves discriminated union members. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type SweepEventHandler = (event: SweepEvent) => void;

/** Minimal wallet interface — avoids coupling to GolemWallet. */
interface SweepWallet {
  getBalance(): Promise<{ available: number }>;
}

/** Minimal lightning interface — avoids coupling to ArkadeSwaps. */
interface SweepLightning {
  sendLightningPayment(params: { invoice: string }): Promise<{ preimage: string }>;
}

/**
 * Automated sweep agent — monitors wallet balance and sweeps excess
 * to a Lightning destination when threshold is exceeded.
 *
 * Follows the same polling pattern as RefreshAgent.
 */
export class AutoSweep {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSweepTime = 0;
  private sweepInProgress = false;
  private readonly COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

  constructor(
    private readonly wallet: SweepWallet,
    private readonly lightning: SweepLightning,
    private readonly config: SweepConfig,
    private readonly onEvent?: SweepEventHandler,
    private readonly onSweep?: (amount: number, destination: string) => void,
    private readonly onError?: (error: string) => void,
  ) {}

  /** Start the polling loop. */
  start(intervalMs = 60_000): void {
    if (this.running) return;
    this.running = true;
    void this.checkAndSweep();
    this.timer = setInterval(() => void this.checkAndSweep(), intervalMs);
  }

  /** Stop the polling loop. Waits for in-progress sweep to complete. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit({ type: 'stopped' });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Validate sweep config at startup. Returns error string or null. */
  static validateConfig(config: SweepConfig): string | null {
    try {
      detectAddressType(config.address);
    } catch (err) {
      return `Invalid sweep address: ${err instanceof Error ? err.message : err}`;
    }

    if (config.threshold <= config.keep) {
      return 'Sweep threshold must be greater than keep amount';
    }

    return null;
  }

  /** Run a single check-and-sweep cycle (public for testing). */
  async checkAndSweep(): Promise<void> {
    if (this.sweepInProgress) return;

    try {
      const { available } = await this.wallet.getBalance();

      this.emit({ type: 'check', balance: available, threshold: this.config.threshold });

      // Below threshold — nothing to do
      if (available <= this.config.threshold) {
        this.emit({ type: 'sweep_skip', reason: 'balance below threshold' });
        return;
      }

      const sweepAmount = available - this.config.keep;

      // Below minimum sweep
      if (sweepAmount < this.config.minSweep) {
        this.emit({ type: 'sweep_skip', reason: `sweep amount ${sweepAmount} below minimum ${this.config.minSweep}` });
        return;
      }

      // Cooldown check
      const now = Date.now();
      if (this.lastSweepTime > 0 && (now - this.lastSweepTime) < this.COOLDOWN_MS) {
        this.emit({ type: 'sweep_skip', reason: 'cooldown active' });
        return;
      }

      this.sweepInProgress = true;

      // Resolve address to bolt11 invoice
      const resolved = await resolveToInvoice(this.config.address, sweepAmount);

      // Re-check balance before executing (race condition guard)
      const recheck = await this.wallet.getBalance();
      if (recheck.available <= this.config.threshold) {
        this.emit({ type: 'sweep_skip', reason: 'balance changed below threshold before sweep' });
        this.sweepInProgress = false;
        return;
      }

      this.emit({ type: 'sweep_start', amount: resolved.amountSats, destination: this.config.address });

      // Execute Boltz submarine swap
      const result = await this.lightning.sendLightningPayment({ invoice: resolved.bolt11 });

      this.lastSweepTime = Date.now();
      this.sweepInProgress = false;

      this.emit({
        type: 'sweep_ok',
        amount: resolved.amountSats,
        destination: this.config.address,
        preimage: result.preimage,
      });

      this.onSweep?.(resolved.amountSats, this.config.address);
    } catch (err) {
      this.sweepInProgress = false;
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'sweep_error', error: message });
      this.onError?.(message);
    }
  }

  private emit(event: DistributiveOmit<SweepEvent, 'timestamp'>): void {
    this.onEvent?.({ ...event, timestamp: new Date().toISOString() } as SweepEvent);
  }
}
