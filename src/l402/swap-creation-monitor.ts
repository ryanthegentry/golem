/**
 * Swap-creation monitor — is the thing we sell actually sellable right now?
 *
 * Context (2026-08-03). Boltz disabled swap creation at 08:52:56Z and every `/l402/challenge`
 * failed for the rest of the day. `/l402/status` reported `healthy: true, boltzReachable: true`
 * throughout, because `boltzReachable` probes `GET /version` — which kept answering 200, as
 * did every other read endpoint. `GET` pairs, `GET` limits and `GET` swap status were all
 * fine. Only creation was off, and nothing on the health surface tested creation. The outage
 * was caught three hours seventeen minutes late, by a digest grepping logs.
 *
 * This module fixes the category error: a dependency being *reachable* is not the same as a
 * capability being *available*, and health has to track the second one.
 *
 * It works by observing real challenge attempts rather than probing. Creating a swap to test
 * whether swaps can be created would leave a real, unfunded swap object on Boltz every
 * interval — pure waste, and Boltz's problem as much as ours. The tradeoff is that the
 * monitor only learns from traffic: with no challenge attempts at all it reports the last
 * thing it saw. In production that is covered, because the Atlas watchdog mints a challenge
 * every 30 minutes; if that watchdog is ever retired, this monitor goes blind with it.
 */

/**
 * How a creation failure should be read.
 *
 * `refused` — the upstream answered, deliberately, that it will not do this. Retrying is
 * pointless by definition. One occurrence is conclusive.
 *
 * `transient` — the request did not get a clean answer: dropped connection, timeout, 5xx.
 * Jul 28–31 produced 2–7 of these a day and they self-healed every time, so a single one
 * means nothing and only a run of them is worth acting on.
 */
export type CreationFailureClass = 'refused' | 'transient';

/** What changed as a result of recording an outcome — the thing worth alerting on. */
export type CreationTransition = 'broke' | 'recovered';

/**
 * Deterministic upstream refusals, matched on message text.
 *
 * Text matching is unlovely and it is what the transport gives us: the SDK surfaces the
 * upstream body as a message string with no structured error code to switch on. Keep this
 * list short and specific — anything not listed falls through to `transient`, which is the
 * safe default. A missed refusal costs a delayed alert; a false one takes the gateway down
 * over a blip.
 */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /swap creation is disabled/i,
];

/**
 * Consecutive transient failures before creation is declared unavailable.
 *
 * Three: at the watchdog's 30-minute cadence that is roughly 90 minutes of continuous
 * failure, which is well clear of the Jul 28–31 flakiness and still far inside the 3h17m
 * detection gap this monitor exists to close.
 */
export const TRANSIENT_FAILURE_THRESHOLD = 3;

export function classifyCreationFailure(message: string): CreationFailureClass {
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(message)) return 'refused';
  }
  return 'transient';
}

export interface SwapCreationHealth {
  /** Whether a challenge can be minted right now, on the evidence available. */
  creatable: boolean;
  /** How the current run of failures reads, or null when the last attempt succeeded. */
  classification: CreationFailureClass | null;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export class SwapCreationMonitor {
  private creatable = true;
  private classification: CreationFailureClass | null = null;
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private lastError: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;

  /**
   * Record a challenge that was minted. This is the only positive evidence that exists —
   * the absence of failures is not, since it is indistinguishable from no traffic.
   *
   * @returns `'recovered'` on the success that ends an outage, otherwise null.
   */
  recordSuccess(): CreationTransition | null {
    const wasBroken = !this.creatable;

    this.creatable = true;
    this.classification = null;
    this.consecutiveFailures = 0;
    this.totalSuccesses += 1;
    this.lastSuccessAt = new Date().toISOString();

    return wasBroken ? 'recovered' : null;
  }

  /**
   * Record a challenge that could not be minted.
   *
   * @returns `'broke'` on the failure that first declares creation unavailable, otherwise
   *          null — so a caller can alert on the edge without re-alerting every 30 minutes
   *          for the length of the outage.
   */
  recordFailure(message: string): CreationTransition | null {
    const wasCreatable = this.creatable;

    this.classification = classifyCreationFailure(message);
    this.consecutiveFailures += 1;
    this.totalFailures += 1;
    this.lastError = message;
    this.lastFailureAt = new Date().toISOString();

    // A refusal is conclusive on its own; a transient run has to earn it.
    if (this.classification === 'refused' || this.consecutiveFailures >= TRANSIENT_FAILURE_THRESHOLD) {
      this.creatable = false;
    }

    return wasCreatable && !this.creatable ? 'broke' : null;
  }

  getHealth(): SwapCreationHealth {
    return {
      creatable: this.creatable,
      classification: this.classification,
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }
}
