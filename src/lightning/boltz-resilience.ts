/**
 * Boltz swap-poller resilience — circuit breaker, log-flood suppression, and rebind.
 *
 * Context (golem#2). `@arkade-os/boltz-swap` 0.3.32's SwapManager retires a swap only when
 * Boltz answers a poll with a 404 whose body matches "could not find swap". Every other
 * failure — 429, 5xx, timeout, schema drift — lands on a bare `logger.error` with no
 * counter, no backoff and no ceiling, and the swap is polled again 30 seconds later. With a
 * few hundred stale swaps in the repository that is a permanent error stream, which is what
 * blinded Railway's log pipeline for two days running.
 *
 * The SDK gives us two seams and this module uses both: `setLogger` to observe and gate what
 * the SwapManager emits, and `setPollInterval` to slow the poller down once we conclude Boltz
 * is not answering. Failures are counted, not echoed; once the breaker opens the per-swap
 * lines stop and one structured line per interval takes their place.
 *
 * The breaker closes on a positive probe result, not on the absence of failures — silence
 * from a stopped poller is not evidence of recovery.
 */

/** Log sink shape — matches the SDK's exported `Logger` interface. */
export interface ResilienceLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type BreakerState = 'closed' | 'open';

/** What a line emitted by the SDK's SwapManager tells us. */
export type SdkLogClass = 'poll-failure' | 'swap-retiring' | 'already-running' | 'other';

/**
 * The SwapManager's poll-failure lines, verbatim from 0.3.32. Matching on message text is
 * unlovely, but the SDK exposes no failure event — `onSwapFailed` fires only after the
 * not-found threshold retires a swap, which is precisely the path that never runs here.
 *
 * These are the lines that mean Boltz did not answer.
 */
const POLL_FAILURE_PATTERNS: readonly RegExp[] = [
  /^Failed to poll swap /,
  /^Retry poll for swap /,
  /^Rate-limited polling swap /,
  /^Failed to resume swap /,
];

/**
 * Boltz answered with "could not find swap". The SDK counts these per swap and retires the
 * swap after ten, so the situation is already bounded and already resolving. Noisy, but not
 * evidence that Boltz is unreachable — see the classification test for why that distinction
 * decides whether the breaker fires.
 */
const SWAP_RETIRING_PATTERNS: readonly RegExp[] = [
  /unknown to Boltz \(/,
  /marked failed after \d+ consecutive Boltz 404s/,
];

const ALREADY_RUNNING_PATTERN = /SwapManager is already running/;

/** Pulls the swap id out of a poll-failure line, for the distinct-swap count. */
const SWAP_ID_PATTERN = /swap (?:')?([A-Za-z0-9_-]+)(?:')?/;

export function classifySdkLogLine(line: unknown): SdkLogClass {
  const text = typeof line === 'string' ? line : String(line);
  if (ALREADY_RUNNING_PATTERN.test(text)) return 'already-running';
  for (const pattern of SWAP_RETIRING_PATTERNS) {
    if (pattern.test(text)) return 'swap-retiring';
  }
  for (const pattern of POLL_FAILURE_PATTERNS) {
    if (pattern.test(text)) return 'poll-failure';
  }
  return 'other';
}

function extractSwapId(line: unknown): string | null {
  const text = typeof line === 'string' ? line : String(line);
  // "Swap abc-123: unknown to Boltz (3/10 consecutive)"
  const leading = /^Swap ([A-Za-z0-9_-]+):/.exec(text);
  if (leading) return leading[1];
  const inline = SWAP_ID_PATTERN.exec(text);
  return inline ? inline[1] : null;
}

export const DEFAULT_RESILIENCE_CONFIG = {
  /**
   * Consecutive poll failures before the breaker opens. At the SDK's 30s cadence with a
   * populated repository this trips within one poll cycle of a real Boltz outage, while a
   * single blip on a handful of swaps rides through.
   */
  failureThreshold: 10,
  /** The SDK's own default poll interval — what we restore on recovery. */
  normalPollIntervalMs: 30_000,
  /**
   * Slow probe cadence while open. Sits exactly on the SDK's `maxPollIntervalMs` ceiling;
   * anything higher is clamped by `setPollInterval` and logs a warning of its own.
   */
  slowProbePollIntervalMs: 300_000,
  /** Rolling window for the error count reported on the health endpoint. */
  errorWindowMs: 60_000,
  /** How long the breaker must stay open before we force a subscription rebind. */
  rebindAfterOpenMs: 120_000,
  /** Ceiling on the exponential backoff between rebind attempts. */
  rebindBackoffCeilingMs: 1_800_000,
} as const;

/** The SwapManager surface this module drives. `setPollInterval` is on the concrete
 *  SwapManager class rather than the exported `SwapManagerClient` interface, so it is
 *  treated as optional and capability-checked before use. */
export interface AttachableSwapManager {
  setPollInterval?: (ms: number) => void;
  getStats: () => Promise<{
    isRunning: boolean;
    monitoredSwaps: number;
    websocketConnected: boolean;
    usePollingFallback: boolean;
  }>;
  onWebSocketConnected?: (listener: () => void) => Promise<() => void>;
  onWebSocketDisconnected?: (listener: () => void) => Promise<() => void>;
}

export interface LightningHealth {
  breakerState: BreakerState;
  /** Null until the first successful probe — a fresh process has proven nothing yet. */
  lastSuccessfulPollAt: number | null;
  errorCount60s: number;
  consecutiveFailures: number;
  /** Increments on every WebSocket (re)connect and every successful rebind. The SDK
   *  multiplexes one subscription per swap over a single socket, so there is no single
   *  Boltz-issued subscription id to report; the epoch is the honest analogue. */
  subscriptionEpoch: number;
  monitoredSwaps: number;
  websocketConnected: boolean;
  openedAt: number | null;
  suppressedSinceOpen: number;
}

export interface BoltzPollMonitorOptions {
  sink?: ResilienceLogger;
  now?: () => number;
  failureThreshold?: number;
  normalPollIntervalMs?: number;
  slowProbePollIntervalMs?: number;
  errorWindowMs?: number;
  rebindAfterOpenMs?: number;
  rebindBackoffCeilingMs?: number;
  /** Forces a fresh subscription. Wired to stop+start of the SwapManager in production. */
  rebind?: () => Promise<void>;
  /** Positive liveness check against Boltz. Drives the breaker closed. */
  probe?: () => Promise<boolean>;
}

export class BoltzPollMonitor {
  private readonly sink: ResilienceLogger;
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly normalPollIntervalMs: number;
  private readonly slowProbePollIntervalMs: number;
  private readonly errorWindowMs: number;
  private readonly rebindAfterOpenMs: number;
  private readonly rebindBackoffCeilingMs: number;
  private readonly rebindFn?: () => Promise<void>;
  private readonly probeFn?: () => Promise<boolean>;

  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private failureTimestamps: number[] = [];
  private lastSuccessfulPollAt: number | null = null;
  private openedAt: number | null = null;
  private suppressedSinceOpen = 0;
  private distinctSwapsSinceOpen = new Set<string>();
  private subscriptionEpoch = 0;
  private monitoredSwaps = 0;
  private websocketConnected = false;

  private lastRebindAt: number | null = null;
  private currentRebindDelayMs: number;

  private swapManager: AttachableSwapManager | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(options: BoltzPollMonitorOptions = {}) {
    this.sink = options.sink ?? console;
    this.now = options.now ?? Date.now;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_RESILIENCE_CONFIG.failureThreshold;
    this.normalPollIntervalMs =
      options.normalPollIntervalMs ?? DEFAULT_RESILIENCE_CONFIG.normalPollIntervalMs;
    this.slowProbePollIntervalMs =
      options.slowProbePollIntervalMs ?? DEFAULT_RESILIENCE_CONFIG.slowProbePollIntervalMs;
    this.errorWindowMs = options.errorWindowMs ?? DEFAULT_RESILIENCE_CONFIG.errorWindowMs;
    this.rebindAfterOpenMs =
      options.rebindAfterOpenMs ?? DEFAULT_RESILIENCE_CONFIG.rebindAfterOpenMs;
    this.rebindBackoffCeilingMs =
      options.rebindBackoffCeilingMs ?? DEFAULT_RESILIENCE_CONFIG.rebindBackoffCeilingMs;
    this.rebindFn = options.rebind;
    this.probeFn = options.probe;
    this.currentRebindDelayMs = this.rebindAfterOpenMs;
  }

  /**
   * Returns a Logger to hand to the SDK's `setLogger`. Poll failures are counted here and
   * forwarded only while the breaker is closed; everything else passes straight through.
   */
  createSdkLogger(): ResilienceLogger {
    const forward = (level: keyof ResilienceLogger, args: unknown[]) => {
      const [first] = args;
      const kind = classifySdkLogLine(first);

      if (kind === 'already-running') {
        // Idempotent init makes this branch the expected path, not a fault. Golem verifies
        // the cached manager separately (see ensureSwapManagerHealthy).
        this.sink.log('[lightning] SwapManager init was already running — verified, not restarted');
        return;
      }

      if (kind === 'poll-failure' || kind === 'swap-retiring') {
        // Retirement lines are counted and suppressed like any other noise, but they do not
        // move the breaker — Boltz answering "no such swap" is Boltz answering.
        this.recordFailure(first, { trips: kind === 'poll-failure' });
        if (this.state === 'closed') this.sink[level](...args);
        return;
      }

      this.sink[level](...args);
    };

    return {
      log: (...args: unknown[]) => forward('log', args),
      warn: (...args: unknown[]) => forward('warn', args),
      error: (...args: unknown[]) => forward('error', args),
    };
  }

  attach(swapManager: AttachableSwapManager): void {
    this.swapManager = swapManager;

    swapManager.onWebSocketConnected
      ?.(() => {
        this.websocketConnected = true;
        this.subscriptionEpoch += 1;
      })
      .then((unsub) => this.unsubscribers.push(unsub))
      .catch(() => {
        /* observability only — never fail startup on a listener */
      });

    swapManager.onWebSocketDisconnected
      ?.(() => {
        this.websocketConnected = false;
      })
      .then((unsub) => this.unsubscribers.push(unsub))
      .catch(() => {
        /* as above */
      });
  }

  private recordFailure(line: unknown, options: { trips?: boolean } = {}): void {
    const trips = options.trips ?? true;
    const at = this.now();
    this.failureTimestamps.push(at);
    this.pruneWindow(at);
    if (trips) this.consecutiveFailures += 1;

    if (this.state === 'open') {
      this.suppressedSinceOpen += 1;
      const id = extractSwapId(line);
      if (id) this.distinctSwapsSinceOpen.add(id);
      return;
    }

    if (trips && this.consecutiveFailures >= this.failureThreshold) this.open();
  }

  private pruneWindow(at: number): void {
    const cutoff = at - this.errorWindowMs;
    if (this.failureTimestamps.length && this.failureTimestamps[0] <= cutoff) {
      this.failureTimestamps = this.failureTimestamps.filter((t) => t > cutoff);
    }
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.suppressedSinceOpen = 0;
    this.distinctSwapsSinceOpen.clear();
    this.lastRebindAt = null;
    this.currentRebindDelayMs = this.rebindAfterOpenMs;

    this.applyPollInterval(this.slowProbePollIntervalMs);
    this.sink.warn(
      `boltz_poll_breaker state=open reason=consecutive_poll_failures ` +
        `threshold=${this.failureThreshold} poll_interval_ms=${this.slowProbePollIntervalMs}`,
    );

    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick();
      }, this.slowProbePollIntervalMs);
      this.timer.unref?.();
    }
  }

  private close(): void {
    if (this.state === 'closed') return;
    const openForMs = this.openedAt === null ? 0 : this.now() - this.openedAt;
    this.state = 'closed';
    this.openedAt = null;
    this.consecutiveFailures = 0;

    this.applyPollInterval(this.normalPollIntervalMs);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.sink.log(
      `boltz_poll_breaker state=closed recovered_after_ms=${openForMs} ` +
        `suppressed=${this.suppressedSinceOpen} poll_interval_ms=${this.normalPollIntervalMs}`,
    );
    this.suppressedSinceOpen = 0;
    this.distinctSwapsSinceOpen.clear();
  }

  private applyPollInterval(ms: number): void {
    try {
      this.swapManager?.setPollInterval?.(ms);
    } catch {
      /* a poller that refuses to be slowed is not a reason to crash the gateway */
    }
  }

  /** Feed a liveness result in. `true` closes the breaker and marks a successful poll. */
  async recordProbeResult(ok: boolean): Promise<void> {
    if (!ok) {
      this.recordFailure('probe failed');
      return;
    }
    this.lastSuccessfulPollAt = this.now();
    this.consecutiveFailures = 0;
    this.close();
  }

  /**
   * One slow-probe cycle: emit the interval summary, refresh stats, probe, and rebind if the
   * breaker has been open long enough. Emits its summary synchronously so a caller driving
   * fake timers sees exactly one line per interval.
   */
  async tick(): Promise<void> {
    if (this.state !== 'open') return;

    const at = this.now();
    this.pruneWindow(at);
    const openForMs = this.openedAt === null ? 0 : at - this.openedAt;

    this.sink.warn(
      `boltz_poll_breaker state=open open_for_ms=${openForMs} ` +
        `suppressed=${this.suppressedSinceOpen} distinct_swaps=${this.distinctSwapsSinceOpen.size} ` +
        `errors_60s=${this.failureTimestamps.length} monitored_swaps=${this.monitoredSwaps} ` +
        `ws_connected=${this.websocketConnected} epoch=${this.subscriptionEpoch}`,
    );
    this.suppressedSinceOpen = 0;
    this.distinctSwapsSinceOpen.clear();

    await this.refreshManagerStats();

    if (this.probeFn) {
      try {
        if (await this.probeFn()) {
          await this.recordProbeResult(true);
          return;
        }
      } catch {
        /* probe failure keeps the breaker open — fall through to rebind */
      }
    }

    await this.maybeRebind(at, openForMs);
  }

  private async maybeRebind(at: number, openForMs: number): Promise<void> {
    if (!this.rebindFn) return;
    if (openForMs < this.rebindAfterOpenMs) return;
    if (this.lastRebindAt !== null && at - this.lastRebindAt < this.currentRebindDelayMs) return;

    this.lastRebindAt = at;
    try {
      await this.rebindFn();
      this.subscriptionEpoch += 1;
      this.sink.warn(
        `boltz_poll_breaker action=rebind result=ok epoch=${this.subscriptionEpoch}`,
      );
    } catch (err) {
      this.sink.warn(
        `boltz_poll_breaker action=rebind result=error ` +
          `message=${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Back off whether or not the rebind threw — a rebind that "succeeded" without
      // restoring polling should not be retried at the base cadence either.
      this.currentRebindDelayMs = Math.min(
        this.currentRebindDelayMs * 2,
        this.rebindBackoffCeilingMs,
      );
    }
  }

  async refreshManagerStats(): Promise<void> {
    if (!this.swapManager) return;
    try {
      const stats = await this.swapManager.getStats();
      this.monitoredSwaps = stats.monitoredSwaps;
      this.websocketConnected = stats.websocketConnected;
    } catch {
      /* stats are advisory; a failure here must not disturb the breaker */
    }
  }

  getHealth(): LightningHealth {
    this.pruneWindow(this.now());
    return {
      breakerState: this.state,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      errorCount60s: this.failureTimestamps.length,
      consecutiveFailures: this.consecutiveFailures,
      subscriptionEpoch: this.subscriptionEpoch,
      monitoredSwaps: this.monitoredSwaps,
      websocketConnected: this.websocketConnected,
      openedAt: this.openedAt,
      suppressedSinceOpen: this.suppressedSinceOpen,
    };
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    this.unsubscribers = [];
  }
}
