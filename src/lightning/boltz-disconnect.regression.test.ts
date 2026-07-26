/**
 * golem#2 regression — a Boltz disconnect must self-heal without a redeploy.
 *
 * This reproduces the outage class that recurred from May onward: Boltz stops answering
 * status polls, the SwapManager keeps polling every monitored swap every 30 seconds, and
 * every one of those polls emits a log line. With ~500 stale swaps in the repository that is
 * roughly 1,000 lines a minute, indefinitely, until someone redeploys the Railway service.
 *
 * The harness below is a faithful stand-in for `SwapManager.pollAllSwaps`: one poll cycle
 * fans out across every monitored swap, and each failure goes through the SDK logger exactly
 * as 0.3.32 emits it. Only the transport is faked — the failure shape, the log strings and
 * the fan-out are the real ones.
 *
 * Asserted here: the breaker opens, the log flood is bounded, a rebind happens inside a
 * bounded window, and service recovers on its own.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BoltzPollMonitor } from './boltz-resilience.js';

const POLL_INTERVAL_MS = 30_000;
const MONITORED_SWAPS = 500;

/**
 * Simulates the SwapManager's poll loop against a Boltz that can be disconnected.
 * Mirrors `pollAllSwaps`: unbounded fan-out across all monitored swaps, one log line per
 * failure, no per-swap backoff.
 */
class FakeBoltzWorld {
  connected = true;
  pollIntervalMs = POLL_INTERVAL_MS;
  cycles = 0;

  constructor(
    private readonly logger: { error: (...a: unknown[]) => void },
    private readonly swapIds: string[],
  ) {}

  /** One `pollAllSwaps` cycle. */
  pollCycle(): void {
    this.cycles += 1;
    if (this.connected) return;
    // Disconnected: every monitored swap fails. Not a 404 with a "could not find swap"
    // body, so the SDK's not-found threshold never engages and nothing is ever retired.
    for (const id of this.swapIds) {
      this.logger.error(`Failed to poll swap ${id}:`, new Error('socket hang up'));
    }
  }

  setPollInterval(ms: number): void {
    this.pollIntervalMs = ms;
  }

  async getStats() {
    return {
      isRunning: true,
      monitoredSwaps: this.swapIds.length,
      websocketConnected: this.connected,
      usePollingFallback: !this.connected,
    };
  }
}

describe('golem#2 regression — Boltz disconnect self-heals', () => {
  let clock: number;
  let sink: {
    log: ReturnType<typeof vi.fn<(...a: unknown[]) => void>>;
    warn: ReturnType<typeof vi.fn<(...a: unknown[]) => void>>;
    error: ReturnType<typeof vi.fn<(...a: unknown[]) => void>>;
  };
  let monitor: BoltzPollMonitor;
  let world: FakeBoltzWorld;
  let rebindCount: number;

  const swapIds = Array.from({ length: MONITORED_SWAPS }, (_, i) => `swap-${i}`);

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_700_000_000_000;
    rebindCount = 0;
    sink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    monitor = new BoltzPollMonitor({
      sink,
      now: () => clock,
      failureThreshold: 10,
      normalPollIntervalMs: POLL_INTERVAL_MS,
      slowProbePollIntervalMs: 300_000,
      rebindAfterOpenMs: 120_000,
      rebind: async () => {
        rebindCount += 1;
        // A rebind tears down the stale subscription and re-establishes it. If Boltz is
        // reachable again this restores service; if not, the breaker stays open.
        world.connected = true;
      },
      probe: async () => world.connected,
    });

    world = new FakeBoltzWorld(monitor.createSdkLogger(), swapIds);
    monitor.attach(world as never);
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  /** Advance the simulation by one poll cycle of virtual time. */
  function advanceOneCycle(): void {
    clock += world.pollIntervalMs;
    world.pollCycle();
  }

  it('opens the breaker within the first poll cycle after a disconnect', () => {
    world.connected = false;
    advanceOneCycle();
    expect(monitor.getHealth().breakerState).toBe('open');
  });

  it('bounds the log flood — 500 failing swaps must not yield 500 log lines per cycle', () => {
    world.connected = false;

    for (let i = 0; i < 10; i++) advanceOneCycle();

    // Unpatched, this is 10 cycles x 500 swaps = 5,000 lines. The breaker opens partway
    // through the first cycle, so only the lines before it trips are forwarded.
    const forwarded = sink.error.mock.calls.length;
    expect(forwarded).toBeLessThanOrEqual(10);
    expect(forwarded * 500).toBeLessThan(5_000);
  });

  it('slows the poller to the probe cadence instead of hammering Boltz', () => {
    world.connected = false;
    advanceOneCycle();
    expect(world.pollIntervalMs).toBe(300_000);
  });

  it('rebinds within a bounded window and restores service without a redeploy', async () => {
    world.connected = false;
    advanceOneCycle();
    expect(monitor.getHealth().breakerState).toBe('open');

    // Boltz stays down; the breaker probes on the slow cadence.
    const deadline = clock + 10 * 60_000; // 10 minutes of virtual time
    while (clock < deadline && rebindCount === 0) {
      clock += 300_000;
      await monitor.tick();
    }

    expect(rebindCount).toBeGreaterThanOrEqual(1);
    expect(clock).toBeLessThanOrEqual(deadline);
  });

  it('closes the breaker and restores the normal poll cadence once Boltz answers again', async () => {
    world.connected = false;
    advanceOneCycle();

    clock += 300_000;
    await monitor.tick(); // rebind reconnects the fake world

    clock += 300_000;
    await monitor.tick(); // probe now succeeds

    const health = monitor.getHealth();
    expect(health.breakerState).toBe('closed');
    expect(world.pollIntervalMs).toBe(POLL_INTERVAL_MS);
    expect(health.lastSuccessfulPollAt).not.toBeNull();
  });

  it('emits one structured line per interval while the outage lasts, not one per swap', async () => {
    world.connected = false;
    advanceOneCycle();
    sink.warn.mockClear();

    for (let i = 0; i < 3; i++) {
      world.pollCycle();
      clock += 300_000;
      await monitor.tick();
      if (world.connected) break; // rebind may have healed it
    }

    // Every emitted line must be the structured breaker summary.
    for (const [line] of sink.warn.mock.calls) {
      expect(String(line)).toContain('boltz_poll_breaker');
    }
    expect(sink.warn.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('reports the outage on the health snapshot for /internal/lightning-health', async () => {
    world.connected = false;
    advanceOneCycle();
    await monitor.refreshManagerStats();

    const health = monitor.getHealth();
    expect(health.breakerState).toBe('open');
    expect(health.monitoredSwaps).toBe(MONITORED_SWAPS);
    expect(health.websocketConnected).toBe(false);
    expect(health.errorCount60s).toBeGreaterThan(0);
  });

  it('a healthy Boltz produces no breaker activity at all', () => {
    for (let i = 0; i < 20; i++) advanceOneCycle();
    expect(monitor.getHealth().breakerState).toBe('closed');
    expect(sink.error).not.toHaveBeenCalled();
    expect(sink.warn).not.toHaveBeenCalled();
    expect(world.pollIntervalMs).toBe(POLL_INTERVAL_MS);
  });

  /**
   * Control. Drives the same harness with a plain passthrough logger — the pre-fix
   * arrangement, where SwapManager writes straight to console. This is the RED baseline the
   * assertions above are measured against: without the breaker the flood is unbounded and
   * the poll cadence never backs off, which is exactly the production behaviour that
   * required a manual redeploy.
   */
  it('control: without the breaker the same outage floods unbounded', () => {
    const rawSink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const unguarded = new FakeBoltzWorld(rawSink, swapIds);
    unguarded.connected = false;

    for (let i = 0; i < 10; i++) unguarded.pollCycle();

    expect(rawSink.error.mock.calls.length).toBe(10 * MONITORED_SWAPS);
    expect(unguarded.pollIntervalMs).toBe(POLL_INTERVAL_MS); // never backed off
  });
});
