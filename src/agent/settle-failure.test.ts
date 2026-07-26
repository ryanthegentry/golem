/**
 * Permanent vs transient settle failures.
 *
 * On 2026-07-26 the RefreshAgent attempted a settle every ~2 minutes and got the same answer
 * every time: `INVALID_VTXO_SCRIPT (10): ... is a deprecated key since 2026-07-04T10:00:00Z`.
 * Retrying a rejection the server will never change its mind about is pure noise.
 *
 * It matters again on 2026-07-29. `canRecoverOnchain` is `isSwept || isPastExpiry`, so the
 * moment the batch passes expiry at 14:56:04Z the agent starts trying to renew — whether or not
 * the operator has swept yet. Until the sweep lands the settle still names the deprecated key,
 * so the loop reappears in exactly the window we care about.
 *
 * Worse, each failure increments `consecutiveRefreshFailures`, which gates
 * `attemptEmergencyExit()`. That is inert today only because `safeHarborAddress` is unset.
 */

import { describe, it, expect } from 'vitest';
import { classifySettleFailure, FailureSuppressor } from './settle-failure.js';

const DEPRECATED =
  'INVALID_VTXO_SCRIPT (10): invalid vtxo script: 022b74c2011af089c849383ee527c72325de52df6a788428b68d49e9174053aaba is a deprecated key since 2026-07-04T10:00:00Z';

describe('classifySettleFailure', () => {
  it('treats the deprecated-signer rejection as permanent', () => {
    expect(classifySettleFailure(DEPRECATED)).toBe('permanent');
  });

  it('treats INVALID_VTXO_SCRIPT as permanent whatever the detail', () => {
    expect(classifySettleFailure('INVALID_VTXO_SCRIPT (10): something else')).toBe('permanent');
  });

  it('treats an already-spent input as permanent', () => {
    expect(classifySettleFailure('VTXO_ALREADY_SPENT: input already consumed')).toBe('permanent');
  });

  it('treats network trouble as transient', () => {
    for (const m of ['fetch failed', 'ETIMEDOUT', 'socket hang up', '503 Service Unavailable']) {
      expect(classifySettleFailure(m)).toBe('transient');
    }
  });

  it('treats an unknown message as transient — retrying is the safer default', () => {
    expect(classifySettleFailure('something nobody has seen before')).toBe('transient');
  });

  it('handles a non-string without throwing', () => {
    expect(classifySettleFailure(undefined as never)).toBe('transient');
    expect(classifySettleFailure({ code: 10 } as never)).toBe('transient');
  });
});

describe('FailureSuppressor', () => {
  it('reports a permanent failure once, then suppresses the repeat', () => {
    const s = new FailureSuppressor();
    expect(s.shouldReport(DEPRECATED)).toBe(true);
    expect(s.shouldReport(DEPRECATED)).toBe(false);
    expect(s.shouldReport(DEPRECATED)).toBe(false);
  });

  it('counts what it suppressed', () => {
    const s = new FailureSuppressor();
    s.shouldReport(DEPRECATED);
    s.shouldReport(DEPRECATED);
    s.shouldReport(DEPRECATED);
    expect(s.suppressedCount).toBe(2);
  });

  it('reports again when the failure changes — a new problem deserves a line', () => {
    const s = new FailureSuppressor();
    expect(s.shouldReport(DEPRECATED)).toBe(true);
    expect(s.shouldReport('VTXO_ALREADY_SPENT: nope')).toBe(true);
  });

  it('never suppresses transient failures — those are worth retrying and seeing', () => {
    const s = new FailureSuppressor();
    expect(s.shouldReport('fetch failed')).toBe(true);
    expect(s.shouldReport('fetch failed')).toBe(true);
  });

  it('resets on success, so a recurrence after recovery is reported afresh', () => {
    const s = new FailureSuppressor();
    s.shouldReport(DEPRECATED);
    expect(s.shouldReport(DEPRECATED)).toBe(false);
    s.reset();
    expect(s.shouldReport(DEPRECATED)).toBe(true);
    expect(s.suppressedCount).toBe(0);
  });

  it('tells the caller whether to count the failure against the emergency threshold', () => {
    // consecutiveRefreshFailures gates attemptEmergencyExit(). A rejection the server will
    // never reverse must not march the wallet toward an on-chain exit.
    const s = new FailureSuppressor();
    s.shouldReport(DEPRECATED);
    expect(s.countsTowardEmergency(DEPRECATED)).toBe(false);
    expect(s.countsTowardEmergency('fetch failed')).toBe(true);
  });
});
