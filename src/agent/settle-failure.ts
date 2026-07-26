/**
 * Telling settle failures the server will reverse from ones it will not.
 *
 * On 2026-07-26 the RefreshAgent retried a settle every ~2 minutes and got the same answer
 * each time — `INVALID_VTXO_SCRIPT (10): … is a deprecated key since 2026-07-04T10:00:00Z`.
 * Retrying a rejection that cannot change is noise, and it buries everything else in the log.
 *
 * It recurs by design on 2026-07-29. `canRecoverOnchain` is `isSwept || isPastExpiry`, so the
 * instant the batch passes expiry the agent starts trying to renew, whether or not the operator
 * has swept yet. Until the sweep lands the settle still names the deprecated key.
 *
 * The second reason to care: every failure increments `consecutiveRefreshFailures`, which gates
 * `attemptEmergencyExit()`. A permanent rejection must not march the wallet toward an on-chain
 * exit it does not need. That path is inert today only because `safeHarborAddress` is unset.
 *
 * Same discipline as the Boltz breaker: count, suppress, and emit one structured line.
 */

export type SettleFailureKind = 'permanent' | 'transient';

/**
 * Rejections the server will give again for the same input. Deliberately narrow — anything
 * unrecognised is transient, because retrying costs a request and giving up costs money.
 */
const PERMANENT_PATTERNS: readonly RegExp[] = [
  /INVALID_VTXO_SCRIPT/i,
  /deprecated key/i,
  /VTXO_ALREADY_SPENT/i,
];

export function classifySettleFailure(message: unknown): SettleFailureKind {
  const text = typeof message === 'string' ? message : String(message ?? '');
  return PERMANENT_PATTERNS.some((p) => p.test(text)) ? 'permanent' : 'transient';
}

/**
 * Emits a permanent failure once per distinct message and swallows the repeats, so a condition
 * that cannot resolve on its own gets one line rather than one per cycle.
 */
export class FailureSuppressor {
  private lastPermanent: string | null = null;
  private suppressed = 0;

  /** How many repeats have been swallowed since the last new message or reset. */
  get suppressedCount(): number {
    return this.suppressed;
  }

  /** True when this failure deserves a log line. Transient failures always do. */
  shouldReport(message: unknown): boolean {
    if (classifySettleFailure(message) !== 'permanent') return true;

    const text = typeof message === 'string' ? message : String(message ?? '');
    if (this.lastPermanent === text) {
      this.suppressed += 1;
      return false;
    }
    this.lastPermanent = text;
    this.suppressed = 0;
    return true;
  }

  /**
   * Whether the failure should count toward the emergency-exit threshold. Permanent rejections
   * must not: the wallet is not degrading, the server is simply refusing this input.
   */
  countsTowardEmergency(message: unknown): boolean {
    return classifySettleFailure(message) !== 'permanent';
  }

  /** Clear state after a success, so a later recurrence is reported afresh. */
  reset(): void {
    this.lastPermanent = null;
    this.suppressed = 0;
  }
}
