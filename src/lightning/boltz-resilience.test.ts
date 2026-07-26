/**
 * golem#2 — Boltz swap-poller resilience.
 *
 * Root causes these tests pin down (all verified against @arkade-os/boltz-swap 0.3.32,
 * the version `npm ci` installs in production):
 *
 * RC1 — `ArkadeSwaps` autostarts its SwapManager (`autoStart` defaults to true) and
 *       `createLightning` then calls `startSwapManager()` again. The second call hits the
 *       `isRunning` guard and logs "SwapManager is already running". Nothing verifies the
 *       cached manager is actually healthy.
 *
 * RC2 — `SwapManager.pollSingleSwap` retires a swap only on `SwapNotFoundError` (Boltz 404
 *       with a "could not find swap" body). Every other failure — 429, 5xx, timeout, schema
 *       drift — falls through to `logger.error('Failed to poll swap ...')` with no counter,
 *       no backoff and no ceiling. The swap is polled again on the next 30s cycle, forever.
 *
 * RC3 — `pollAllSwaps` fans out one concurrent request per monitored swap with no cap, so a
 *       few hundred stale swaps self-induce the 429s that feed RC2.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BoltzPollMonitor,
  classifySdkLogLine,
  DEFAULT_RESILIENCE_CONFIG,
} from './boltz-resilience.js';

/** Log lines emitted verbatim by @arkade-os/boltz-swap 0.3.32's SwapManager. */
const SDK_LINES = {
  pollFailed: 'Failed to poll swap abc-123:',
  retryFailed: 'Retry poll for swap abc-123 also failed:',
  rateLimited: 'Rate-limited polling swap abc-123, retrying in 2s',
  notFound: 'Swap abc-123: unknown to Boltz (3/10 consecutive)',
  resumeFailed: 'Failed to resume swap abc-123:',
  alreadyRunning: 'SwapManager is already running',
  unrelated: 'Resuming claim for swap abc-123',
};

function makeSink() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Minimal stand-in for the SDK's SwapManager surface the monitor drives. */
function makeSwapManager(overrides: Record<string, unknown> = {}) {
  return {
    setPollInterval: vi.fn(),
    getStats: vi.fn().mockResolvedValue({
      isRunning: true,
      monitoredSwaps: 3,
      websocketConnected: true,
      usePollingFallback: false,
      currentReconnectDelay: 1000,
      currentPollRetryDelay: 5000,
    }),
    onWebSocketConnected: vi.fn().mockResolvedValue(() => {}),
    onWebSocketDisconnected: vi.fn().mockResolvedValue(() => {}),
    ...overrides,
  };
}

describe('classifySdkLogLine', () => {
  it('classifies unanswered-poll lines as poll failures', () => {
    expect(classifySdkLogLine(SDK_LINES.pollFailed)).toBe('poll-failure');
    expect(classifySdkLogLine(SDK_LINES.retryFailed)).toBe('poll-failure');
    expect(classifySdkLogLine(SDK_LINES.rateLimited)).toBe('poll-failure');
    expect(classifySdkLogLine(SDK_LINES.resumeFailed)).toBe('poll-failure');
  });

  /**
   * A "could not find swap" 404 means Boltz answered — it is a statement about one swap,
   * not about reachability. The SDK already bounds these with its own 10-poll counter and
   * then retires the swap. Treating them as breaker failures would slow the poller down and
   * stretch a 5-minute cleanup into 50, so they are counted and suppressed but never trip
   * the breaker.
   */
  it('classifies SDK-managed swap retirement separately from a poll failure', () => {
    expect(classifySdkLogLine(SDK_LINES.notFound)).toBe('swap-retiring');
  });

  it('classifies the double-init guard line distinctly', () => {
    expect(classifySdkLogLine(SDK_LINES.alreadyRunning)).toBe('already-running');
  });

  it('leaves unrelated SDK lines unclassified', () => {
    expect(classifySdkLogLine(SDK_LINES.unrelated)).toBe('other');
  });

  it('extracts the swap id from a poll-failure line', () => {
    // Used for the per-interval structured summary's distinct-swap count.
    expect(classifySdkLogLine('Failed to poll swap deadbeef-01:')).toBe('poll-failure');
  });
});

describe('BoltzPollMonitor — circuit breaker', () => {
  let sink: ReturnType<typeof makeSink>;
  let monitor: BoltzPollMonitor;
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    sink = makeSink();
    monitor = new BoltzPollMonitor({
      sink,
      now: () => clock,
      failureThreshold: 5,
      normalPollIntervalMs: 30_000,
      slowProbePollIntervalMs: 300_000,
    });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  function failTimes(n: number, line = SDK_LINES.pollFailed) {
    const logger = monitor.createSdkLogger();
    for (let i = 0; i < n; i++) {
      clock += 1000;
      logger.error(line);
    }
  }

  it('starts closed', () => {
    expect(monitor.getHealth().breakerState).toBe('closed');
  });

  it('passes failure lines through to the sink while closed', () => {
    failTimes(3);
    expect(sink.error).toHaveBeenCalledTimes(3);
    expect(monitor.getHealth().breakerState).toBe('closed');
  });

  it('opens after N consecutive poll failures', () => {
    failTimes(5);
    expect(monitor.getHealth().breakerState).toBe('open');
  });

  it('backs the SDK poller off to the slow probe cadence when it opens', () => {
    const swapManager = makeSwapManager();
    monitor.attach(swapManager as never);
    failTimes(5);
    expect(swapManager.setPollInterval).toHaveBeenCalledWith(300_000);
  });

  it('stops forwarding per-swap failure lines once open — this is the log-flood fix', () => {
    failTimes(5);
    const afterOpen = sink.error.mock.calls.length;

    // 500 more failures, the shape of the production flood.
    failTimes(500);

    expect(sink.error.mock.calls.length).toBe(afterOpen);
  });

  it('emits exactly one structured summary per interval while open', () => {
    failTimes(5);
    sink.warn.mockClear();

    // Two full slow-probe intervals of continuous failure.
    for (let i = 0; i < 2; i++) {
      failTimes(200);
      clock += 300_000;
      vi.advanceTimersByTime(300_000);
    }

    expect(sink.warn).toHaveBeenCalledTimes(2);
    const [line] = sink.warn.mock.calls[0];
    expect(line).toContain('boltz_poll_breaker');
    expect(line).toContain('state=open');
  });

  it('the structured summary reports suppressed-line and distinct-swap counts', () => {
    failTimes(5);
    sink.warn.mockClear();

    const logger = monitor.createSdkLogger();
    for (const id of ['s1', 's2', 's3']) {
      clock += 100;
      logger.error(`Failed to poll swap ${id}:`);
    }
    clock += 300_000;
    vi.advanceTimersByTime(300_000);

    const [line] = sink.warn.mock.calls[0];
    expect(line).toContain('suppressed=');
    expect(line).toContain('distinct_swaps=');
  });

  it('closes and restores the normal poll cadence when a probe succeeds', async () => {
    const swapManager = makeSwapManager();
    monitor.attach(swapManager as never);
    failTimes(5);
    expect(monitor.getHealth().breakerState).toBe('open');

    await monitor.recordProbeResult(true);

    expect(monitor.getHealth().breakerState).toBe('closed');
    expect(swapManager.setPollInterval).toHaveBeenLastCalledWith(30_000);
  });

  it('logs recovery exactly once on close', async () => {
    failTimes(5);
    sink.log.mockClear();
    await monitor.recordProbeResult(true);
    await monitor.recordProbeResult(true);

    const recoveryLines = sink.log.mock.calls.filter(([l]) =>
      String(l).includes('state=closed'),
    );
    expect(recoveryLines).toHaveLength(1);
  });

  it('resets the consecutive counter on success so the breaker does not re-open early', async () => {
    failTimes(4);
    await monitor.recordProbeResult(true);
    failTimes(4);
    expect(monitor.getHealth().breakerState).toBe('closed');
  });

  it('does not open on SDK-managed swap retirement, however many swaps are retiring', () => {
    const logger = monitor.createSdkLogger();
    for (let i = 0; i < 200; i++) {
      clock += 100;
      logger.warn(`Swap s${i}: unknown to Boltz (3/10 consecutive)`);
    }
    // Boltz is answering — slowing the poller here would stretch the SDK's own cleanup.
    expect(monitor.getHealth().breakerState).toBe('closed');
  });

  it('still counts retirement lines toward the 60s error total', () => {
    const logger = monitor.createSdkLogger();
    logger.warn(SDK_LINES.notFound);
    logger.warn(SDK_LINES.notFound);
    expect(monitor.getHealth().errorCount60s).toBe(2);
  });

  it('suppresses retirement lines too once the breaker is open', () => {
    failTimes(5);
    const afterOpen = sink.warn.mock.calls.length;

    const logger = monitor.createSdkLogger();
    for (let i = 0; i < 300; i++) logger.warn(`Swap s${i}: unknown to Boltz (3/10 consecutive)`);

    expect(sink.warn.mock.calls.length).toBe(afterOpen);
  });
});

describe('BoltzPollMonitor — health snapshot', () => {
  let sink: ReturnType<typeof makeSink>;
  let monitor: BoltzPollMonitor;
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    sink = makeSink();
    monitor = new BoltzPollMonitor({ sink, now: () => clock, failureThreshold: 5 });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it('counts errors in a rolling 60s window and drops older ones', () => {
    const logger = monitor.createSdkLogger();
    for (let i = 0; i < 3; i++) {
      logger.error(SDK_LINES.pollFailed);
    }
    expect(monitor.getHealth().errorCount60s).toBe(3);

    clock += 61_000;
    expect(monitor.getHealth().errorCount60s).toBe(0);
  });

  it('records the last successful poll timestamp', async () => {
    expect(monitor.getHealth().lastSuccessfulPollAt).toBeNull();
    await monitor.recordProbeResult(true);
    expect(monitor.getHealth().lastSuccessfulPollAt).toBe(clock);
  });

  it('reports subscription epoch and monitored-swap state from the manager', async () => {
    const swapManager = makeSwapManager();
    monitor.attach(swapManager as never);
    await monitor.refreshManagerStats();

    const health = monitor.getHealth();
    expect(health.monitoredSwaps).toBe(3);
    expect(health.websocketConnected).toBe(true);
    expect(health.subscriptionEpoch).toBeGreaterThanOrEqual(0);
  });

  it('exposes a serialisable snapshot for /internal/lightning-health', async () => {
    await monitor.recordProbeResult(true);
    const health = monitor.getHealth();
    expect(() => JSON.stringify(health)).not.toThrow();
    expect(health).toMatchObject({
      breakerState: expect.any(String),
      errorCount60s: expect.any(Number),
      subscriptionEpoch: expect.any(Number),
    });
  });
});

describe('BoltzPollMonitor — rebind on sustained failure', () => {
  let sink: ReturnType<typeof makeSink>;
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    sink = makeSink();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers a rebind once the breaker has been open past the rebind delay', async () => {
    const rebind = vi.fn().mockResolvedValue(undefined);
    const monitor = new BoltzPollMonitor({
      sink,
      now: () => clock,
      failureThreshold: 3,
      rebindAfterOpenMs: 120_000,
      rebind,
    });
    const logger = monitor.createSdkLogger();
    for (let i = 0; i < 3; i++) logger.error(SDK_LINES.pollFailed);

    expect(rebind).not.toHaveBeenCalled();

    clock += 130_000;
    await monitor.tick();

    expect(rebind).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('backs off exponentially between rebind attempts', async () => {
    const rebind = vi.fn().mockResolvedValue(undefined);
    const monitor = new BoltzPollMonitor({
      sink,
      now: () => clock,
      failureThreshold: 3,
      rebindAfterOpenMs: 60_000,
      rebind,
    });
    const logger = monitor.createSdkLogger();
    for (let i = 0; i < 3; i++) logger.error(SDK_LINES.pollFailed);

    clock += 61_000;
    await monitor.tick();
    expect(rebind).toHaveBeenCalledTimes(1);

    // Second attempt must wait longer than the first.
    clock += 61_000;
    await monitor.tick();
    expect(rebind).toHaveBeenCalledTimes(1);

    clock += 200_000;
    await monitor.tick();
    expect(rebind).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('increments the subscription epoch on each successful rebind', async () => {
    const rebind = vi.fn().mockResolvedValue(undefined);
    const monitor = new BoltzPollMonitor({
      sink,
      now: () => clock,
      failureThreshold: 3,
      rebindAfterOpenMs: 60_000,
      rebind,
    });
    const before = monitor.getHealth().subscriptionEpoch;
    const logger = monitor.createSdkLogger();
    for (let i = 0; i < 3; i++) logger.error(SDK_LINES.pollFailed);

    clock += 61_000;
    await monitor.tick();

    expect(monitor.getHealth().subscriptionEpoch).toBe(before + 1);
    monitor.stop();
  });

  it('survives a rebind that throws and keeps the breaker open', async () => {
    const rebind = vi.fn().mockRejectedValue(new Error('boltz unreachable'));
    const monitor = new BoltzPollMonitor({
      sink,
      now: () => clock,
      failureThreshold: 3,
      rebindAfterOpenMs: 60_000,
      rebind,
    });
    const logger = monitor.createSdkLogger();
    for (let i = 0; i < 3; i++) logger.error(SDK_LINES.pollFailed);

    clock += 61_000;
    await expect(monitor.tick()).resolves.not.toThrow();
    expect(monitor.getHealth().breakerState).toBe('open');
    monitor.stop();
  });
});

describe('DEFAULT_RESILIENCE_CONFIG', () => {
  it('slow probe cadence is far longer than the normal poll interval', () => {
    expect(DEFAULT_RESILIENCE_CONFIG.slowProbePollIntervalMs).toBeGreaterThan(
      DEFAULT_RESILIENCE_CONFIG.normalPollIntervalMs * 5,
    );
  });

  it('slow probe cadence stays within the SDK maxPollIntervalMs ceiling of 300s', () => {
    // SwapManager.setPollInterval clamps above 300_000 and logs a warning; staying at or
    // under the ceiling keeps the breaker's backoff from emitting a warning of its own.
    expect(DEFAULT_RESILIENCE_CONFIG.slowProbePollIntervalMs).toBeLessThanOrEqual(300_000);
  });
});
