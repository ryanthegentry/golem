/**
 * Swap-creation monitor tests.
 *
 * Context (2026-08-03). Boltz disabled swap creation at 08:52:56Z. Every `/l402/challenge`
 * failed for the rest of the day — reverse, submarine and chain, every pair, every amount.
 * Throughout it, `/l402/status` reported `healthy: true, boltzReachable: true`, because
 * `boltzReachable` probes `GET /version` and `/version` was answering 200 the whole time.
 * Nothing on the health surface tested the one thing that had broken. The outage was found
 * at 12:09Z by a digest grepping logs — three hours and seventeen minutes late.
 *
 * The lesson is not "probe harder". It is that a liveness check on a dependency's cheapest
 * endpoint is not a readiness check on the capability you actually sell. So this monitor
 * observes real challenge attempts rather than synthesising probe swaps: creating a swap to
 * test whether swaps can be created would leave real objects on Boltz every interval.
 *
 * The classification split matters as much as the counting. Jul 28–31 the gateway was
 * genuinely flaky — `fetch failed`, timeouts, 2–7 a day, self-healing. A deterministic
 * upstream refusal is a different animal and warrants a different response: one occurrence
 * is conclusive, where one timeout is noise.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SwapCreationMonitor, classifyCreationFailure } from './swap-creation-monitor.js';

describe('classifyCreationFailure', () => {
  it('reads the Boltz kill switch as a deterministic refusal', () => {
    expect(
      classifyCreationFailure('Boltz API error: 400 {"error":"swap creation is disabled"}'),
    ).toBe('refused');
  });

  it('is not fooled by case or surrounding noise', () => {
    expect(classifyCreationFailure('Swap Creation Is Disabled')).toBe('refused');
  });

  it('treats a dropped connection as transient', () => {
    expect(classifyCreationFailure('NetworkError: fetch failed')).toBe('transient');
  });

  it('treats a timeout as transient', () => {
    expect(classifyCreationFailure('The operation was aborted due to timeout')).toBe('transient');
  });

  it('treats an upstream 502 as transient', () => {
    expect(classifyCreationFailure('Boltz API error: 502 <html>Bad Gateway</html>')).toBe('transient');
  });

  it('defaults unknown failures to transient rather than crying wolf', () => {
    expect(classifyCreationFailure('something nobody has seen before')).toBe('transient');
  });
});

describe('SwapCreationMonitor', () => {
  let monitor: SwapCreationMonitor;

  beforeEach(() => {
    monitor = new SwapCreationMonitor();
  });

  it('starts out assuming creation works, having no evidence otherwise', () => {
    expect(monitor.getHealth().creatable).toBe(true);
    expect(monitor.getHealth().consecutiveFailures).toBe(0);
  });

  it('goes uncreatable on a single deterministic refusal', () => {
    monitor.recordFailure('Boltz API error: 400 {"error":"swap creation is disabled"}');

    const health = monitor.getHealth();
    expect(health.creatable).toBe(false);
    expect(health.classification).toBe('refused');
    expect(health.lastError).toContain('swap creation is disabled');
  });

  it('tolerates transient failures below the threshold', () => {
    monitor.recordFailure('NetworkError: fetch failed');
    monitor.recordFailure('NetworkError: fetch failed');

    expect(monitor.getHealth().creatable).toBe(true);
    expect(monitor.getHealth().consecutiveFailures).toBe(2);
  });

  it('goes uncreatable once transient failures stop looking transient', () => {
    for (let i = 0; i < 3; i++) monitor.recordFailure('NetworkError: fetch failed');

    const health = monitor.getHealth();
    expect(health.creatable).toBe(false);
    expect(health.classification).toBe('transient');
  });

  it('recovers on a success, which is the only evidence creation works', () => {
    monitor.recordFailure('Boltz API error: 400 {"error":"swap creation is disabled"}');
    expect(monitor.getHealth().creatable).toBe(false);

    monitor.recordSuccess();

    const health = monitor.getHealth();
    expect(health.creatable).toBe(true);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.classification).toBeNull();
  });

  it('a success resets the transient run, so flakiness never accumulates into an outage', () => {
    monitor.recordFailure('NetworkError: fetch failed');
    monitor.recordFailure('NetworkError: fetch failed');
    monitor.recordSuccess();
    monitor.recordFailure('NetworkError: fetch failed');

    expect(monitor.getHealth().creatable).toBe(true);
    expect(monitor.getHealth().consecutiveFailures).toBe(1);
  });

  it('timestamps the last success and the last failure separately', () => {
    monitor.recordSuccess();
    const afterSuccess = monitor.getHealth();
    expect(afterSuccess.lastSuccessAt).not.toBeNull();
    expect(afterSuccess.lastFailureAt).toBeNull();

    monitor.recordFailure('NetworkError: fetch failed');
    const afterFailure = monitor.getHealth();
    expect(afterFailure.lastSuccessAt).toEqual(afterSuccess.lastSuccessAt);
    expect(afterFailure.lastFailureAt).not.toBeNull();
  });

  it('counts every failure, so the digest can quote a rate', () => {
    monitor.recordFailure('NetworkError: fetch failed');
    monitor.recordSuccess();
    monitor.recordFailure('Boltz API error: 400 {"error":"swap creation is disabled"}');

    expect(monitor.getHealth().totalFailures).toBe(2);
    expect(monitor.getHealth().totalSuccesses).toBe(1);
  });

  describe('transition reporting — what an alert should fire on', () => {
    it('reports a transition the first time creation breaks, and not again while it stays broken', () => {
      expect(monitor.recordFailure('Boltz API error: 400 {"error":"swap creation is disabled"}'))
        .toBe('broke');
      expect(monitor.recordFailure('Boltz API error: 400 {"error":"swap creation is disabled"}'))
        .toBeNull();
    });

    it('reports the transient break only at the threshold, not on the way there', () => {
      expect(monitor.recordFailure('NetworkError: fetch failed')).toBeNull();
      expect(monitor.recordFailure('NetworkError: fetch failed')).toBeNull();
      expect(monitor.recordFailure('NetworkError: fetch failed')).toBe('broke');
    });

    it('reports recovery once, on the success that ends an outage', () => {
      monitor.recordFailure('Boltz API error: 400 {"error":"swap creation is disabled"}');
      expect(monitor.recordSuccess()).toBe('recovered');
      expect(monitor.recordSuccess()).toBeNull();
    });

    it('stays quiet on a success that ended nothing', () => {
      expect(monitor.recordSuccess()).toBeNull();
    });
  });
});
