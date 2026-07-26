/**
 * Bounded fan-out for the SwapManager's poll loop (RC3, golem#2).
 *
 * `pollAllSwaps` maps every monitored swap to `pollSingleSwap` and hands the lot to
 * `Promise.allSettled`. With 533 pending swaps in the repository that is 533 concurrent
 * requests to Boltz every 30 seconds — enough to earn a 429, and 429s fall on the branch of
 * `pollSingleSwap` that has no counter and no backoff. The circuit breaker in
 * `boltz-resilience.ts` contains the symptom; a ceiling on concurrency removes the cause.
 *
 * The gate goes on `pollSingleSwap` rather than `pollAllSwaps` because every caller then
 * inherits it — the periodic loop, the WebSocket-reconnect sweep, and the 2s rate-limit
 * retry alike. Queued polls still run; they just wait their turn.
 *
 * This patches an instance method the SDK does not expose for configuration. The version is
 * pinned (`npm ci`, boltz-swap 0.3.32) and `capPollConcurrency` reports false rather than
 * throwing if the method is not where it expects, so an SDK bump degrades to the old
 * unbounded behaviour instead of breaking startup.
 */

/**
 * Concurrent Boltz requests allowed at once. At ~200ms per round trip this drains a
 * 500-swap set in about 12s, inside the SDK's 30s poll interval, while being far below the
 * fan-out that provoked rate limiting.
 */
export const DEFAULT_POLL_CONCURRENCY = 8;

const CAPPED = Symbol.for('golem.pollConcurrencyCapped');

type PollFn = (...args: unknown[]) => Promise<unknown>;

interface CappableManager {
  pollSingleSwap?: PollFn;
  [CAPPED]?: boolean;
}

/**
 * A slot-passing semaphore. On release the slot is handed straight to the next waiter
 * instead of being freed and re-taken, so the in-flight count can never transiently exceed
 * the limit while a waiter is resuming.
 */
function createSemaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * Wrap `pollSingleSwap` so at most `limit` polls are in flight at once.
 *
 * @returns true when the cap was installed; false when the manager does not have the
 *   method, or already has a cap.
 */
export function capPollConcurrency(
  manager: unknown,
  limit: number = DEFAULT_POLL_CONCURRENCY,
): boolean {
  const target = manager as CappableManager | null | undefined;
  if (!target || typeof target.pollSingleSwap !== 'function') return false;
  if (target[CAPPED]) return false;
  // A limit below 1 would queue every poll behind a slot that never opens. Leaving the
  // poller unbounded is bad; deadlocking it is worse.
  if (!Number.isFinite(limit) || limit < 1) return false;

  const original = target.pollSingleSwap;
  const gate = createSemaphore(Math.floor(limit));

  target.pollSingleSwap = function (this: unknown, ...args: unknown[]) {
    return gate(() => original.apply(this ?? target, args));
  };
  target[CAPPED] = true;
  return true;
}
