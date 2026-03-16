import { createHash } from 'node:crypto';
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
  private sweepDoneResolve: (() => void) | null = null;
  private bolt11Consumed = false;
  private usedBolt11s = new Set<string>();
  private consecutiveFailures = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3;
  private circuitBreakerUntil = 0;
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

  /** Stop the polling loop. Does NOT await in-progress sweeps — use stopGraceful() for clean shutdown. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit({ type: 'stopped' });
  }

  /**
   * Gracefully stop: clears interval and waits for any in-progress sweep to complete.
   * If the sweep doesn't complete within timeoutMs, emits a sweep_error and resolves
   * (never blocks forever).
   */
  async stopGraceful(timeoutMs = 30_000): Promise<void> {
    if (!this.running && !this.sweepInProgress) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.sweepInProgress) {
      let timeoutId: ReturnType<typeof setTimeout>;
      await Promise.race([
        new Promise<void>(resolve => {
          this.sweepDoneResolve = resolve;
        }),
        new Promise<void>(resolve => {
          timeoutId = setTimeout(() => {
            this.emit({ type: 'sweep_error', error: 'shutdown timeout — sweep may still be in progress' });
            resolve();
          }, timeoutMs);
        }),
      ]);
      clearTimeout(timeoutId!);
      this.sweepDoneResolve = null;
    }

    this.emit({ type: 'stopped' });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Validate sweep config at startup. Returns error string or null. */
  static validateConfig(config: SweepConfig): string | null {
    if (!config.address) {
      return 'Sweep address is required';
    }

    try {
      detectAddressType(config.address);
    } catch (err) {
      return `Invalid sweep address: ${err instanceof Error ? err.message : err}`;
    }

    if (config.threshold <= 0) {
      return 'Sweep threshold must be positive';
    }

    if (config.minSweep <= 0) {
      return 'Sweep minSweep must be positive';
    }

    if (config.keep < 0) {
      return 'Sweep keep must not be negative';
    }

    if (config.threshold <= config.keep) {
      return 'Sweep threshold must be greater than keep amount';
    }

    return null;
  }

  /** Run a single check-and-sweep cycle (public for testing). */
  async checkAndSweep(): Promise<void> {
    if (this.sweepInProgress) return;

    // Bolt11 consumed — sweep permanently disabled until address is changed
    if (this.bolt11Consumed) {
      this.emit({ type: 'sweep_skip', reason: 'bolt11 invoice already consumed — update sweep.address' });
      return;
    }

    // Circuit breaker — back off after consecutive failures
    if (this.circuitBreakerUntil > 0 && Date.now() < this.circuitBreakerUntil) {
      this.emit({ type: 'sweep_skip', reason: 'circuit breaker active after 3 consecutive failures' });
      return;
    }

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

      // Reject duplicate invoice (e.g., LNURL server returning the same bolt11 twice)
      if (this.usedBolt11s.has(resolved.bolt11)) {
        this.emit({ type: 'sweep_error', error: 'duplicate invoice — bolt11 already consumed' });
        this.sweepInProgress = false;
        this.sweepDoneResolve?.();
        this.sweepDoneResolve = null;
        return;
      }

      // Re-check balance before executing (race condition guard)
      const recheck = await this.wallet.getBalance();
      if (recheck.available <= this.config.threshold) {
        this.emit({ type: 'sweep_skip', reason: 'balance changed below threshold before sweep' });
        this.sweepInProgress = false;
        this.sweepDoneResolve?.();
        this.sweepDoneResolve = null;
        return;
      }

      // Verify re-checked balance can still cover the resolved invoice amount
      const recheckSweepAmount = recheck.available - this.config.keep;
      if (resolved.amountSats > recheckSweepAmount) {
        this.emit({ type: 'sweep_skip', reason: `invoice amount ${resolved.amountSats} exceeds rechecked capacity ${recheckSweepAmount}` });
        this.sweepInProgress = false;
        this.sweepDoneResolve?.();
        this.sweepDoneResolve = null;
        return;
      }
      if (recheckSweepAmount < this.config.minSweep) {
        this.emit({ type: 'sweep_skip', reason: `rechecked sweep amount ${recheckSweepAmount} below minimum ${this.config.minSweep}` });
        this.sweepInProgress = false;
        this.sweepDoneResolve?.();
        this.sweepDoneResolve = null;
        return;
      }

      this.emit({ type: 'sweep_start', amount: resolved.amountSats, destination: this.config.address });

      // Execute Boltz submarine swap.
      // NOTE: AutoSweep calls lightning.sendLightningPayment() directly, bypassing
      // GolemWallet.sendOor()'s OOR limit and sendLock. Sweep payments are Boltz
      // submarine swaps (Ark → Lightning) which settle atomically — there is no
      // unsettled OOR exposure window. The OOR limit protects against unsettled
      // on-Ark sends, which is a different risk profile. (MEDIUM-002 accepted)
      const result = await this.lightning.sendLightningPayment({ invoice: resolved.bolt11 });

      this.lastSweepTime = Date.now();
      this.sweepInProgress = false;
      this.sweepDoneResolve?.();
      this.sweepDoneResolve = null;
      this.consecutiveFailures = 0;

      // Track consumed invoices to prevent duplicate payments
      this.usedBolt11s.add(resolved.bolt11);
      if (this.usedBolt11s.size > 100) {
        const first = this.usedBolt11s.values().next().value!;
        this.usedBolt11s.delete(first);
      }

      // Bolt11 is single-use — disable further sweeps
      if (detectAddressType(this.config.address) === 'bolt11') {
        this.bolt11Consumed = true;
      }

      const paymentHash = createHash('sha256').update(Buffer.from(result.preimage, 'hex')).digest('hex');

      this.emit({
        type: 'sweep_ok',
        amount: resolved.amountSats,
        destination: this.config.address,
        paymentHash,
      });

      if (this.bolt11Consumed) {
        this.emit({ type: 'sweep_skip', reason: 'bolt11 invoice consumed — update sweep.address for future sweeps' });
      }

      this.onSweep?.(resolved.amountSats, this.config.address);
    } catch (err) {
      this.sweepInProgress = false;
      this.sweepDoneResolve?.();
      this.sweepDoneResolve = null;
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        this.circuitBreakerUntil = Date.now() + 6 * this.COOLDOWN_MS; // 1 hour
      }
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'sweep_error', error: message });
      this.onError?.(message);
    }
  }

  private emit(event: DistributiveOmit<SweepEvent, 'timestamp'>): void {
    this.onEvent?.({ ...event, timestamp: new Date().toISOString() } as SweepEvent);
  }
}
