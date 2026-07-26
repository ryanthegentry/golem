/**
 * RC3 from golem#2: `pollAllSwaps` fires one HTTP request per monitored swap through a bare
 * `Promise.allSettled`, with no ceiling, every 30 seconds. With a few hundred swaps in the
 * repository that fan-out is what induced the Boltz rate limiting, and 429s land on the
 * SwapManager's uncounted failure branch. The breaker stopped the flood; this stops the
 * cause.
 */

import { describe, it, expect, vi } from 'vitest';
import { capPollConcurrency, DEFAULT_POLL_CONCURRENCY } from './poll-concurrency.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface FakeManager {
  name: string;
  pollSingleSwap(this: unknown, swap: string): Promise<string>;
  pollAllSwaps(this: FakeManager): Promise<void>;
}

/** A stand-in for the SDK's SwapManager: same call shape, controllable timing. */
function makeManager(swaps: string[]) {
  const gates: Array<() => void> = [];
  const state = { inflight: 0, maxInflight: 0, polled: [] as string[], receivers: [] as unknown[] };

  const manager: FakeManager = {
    name: 'swap-manager',
    async pollSingleSwap(this: unknown, swap: string) {
      state.receivers.push(this);
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      await new Promise<void>((resolve) => gates.push(resolve));
      state.inflight -= 1;
      state.polled.push(swap);
      return swap;
    },
    async pollAllSwaps(this: FakeManager) {
      await Promise.allSettled(swaps.map((swap) => this.pollSingleSwap(swap)));
    },
  };

  /** Release every waiting poll, repeatedly, until the queue empties. */
  async function drain() {
    for (let i = 0; i < 200 && gates.length > 0; i += 1) {
      for (const open of gates.splice(0, gates.length)) open();
      await flush();
    }
  }

  return { manager, state, drain };
}

describe('capPollConcurrency', () => {
  it('holds in-flight polls at the limit', async () => {
    const swaps = Array.from({ length: 50 }, (_, i) => `swap-${i}`);
    const { manager, state, drain } = makeManager(swaps);

    capPollConcurrency(manager, 5);
    const done = manager.pollAllSwaps();
    await flush();

    expect(state.maxInflight).toBe(5);

    await drain();
    await done;
    expect(state.maxInflight).toBe(5);
  });

  it('still polls every swap — the cap delays, it does not drop', async () => {
    const swaps = Array.from({ length: 37 }, (_, i) => `swap-${i}`);
    const { manager, state, drain } = makeManager(swaps);

    capPollConcurrency(manager, 4);
    const done = manager.pollAllSwaps();
    await flush();
    await drain();
    await done;

    expect(state.polled.sort()).toEqual([...swaps].sort());
  });

  it('is unbounded without the cap — the behaviour being fixed', async () => {
    const swaps = Array.from({ length: 50 }, (_, i) => `swap-${i}`);
    const { manager, state, drain } = makeManager(swaps);

    const done = manager.pollAllSwaps();
    await flush();
    expect(state.maxInflight).toBe(50);

    await drain();
    await done;
  });

  it('releases the slot when a poll rejects, so the queue cannot stall', async () => {
    const swaps = ['a', 'b', 'c', 'd', 'e', 'f'];
    let calls = 0;
    interface RejectingManager {
      pollSingleSwap(swap: string): Promise<string>;
      pollAllSwaps(this: RejectingManager): Promise<void>;
    }
    const manager: RejectingManager = {
      async pollSingleSwap(swap: string): Promise<string> {
        calls += 1;
        throw new Error(`boom ${swap}`);
      },
      async pollAllSwaps(this: RejectingManager) {
        await Promise.allSettled(swaps.map((swap) => this.pollSingleSwap(swap)));
      },
    };

    capPollConcurrency(manager, 2);
    await manager.pollAllSwaps();

    expect(calls).toBe(swaps.length);
  });

  it('preserves the receiver so the wrapped method still sees its own instance', async () => {
    const { manager, state, drain } = makeManager(['one']);
    capPollConcurrency(manager, 2);

    const done = manager.pollAllSwaps();
    await flush();
    await drain();
    await done;

    expect(state.receivers).toHaveLength(1);
    expect((state.receivers[0] as { name?: string }).name).toBe('swap-manager');
  });

  it('applies once — a second call does not stack a second gate', () => {
    const { manager } = makeManager(['a']);
    expect(capPollConcurrency(manager, 4)).toBe(true);
    expect(capPollConcurrency(manager, 4)).toBe(false);
  });

  it('does not halve the limit when applied twice', async () => {
    const swaps = Array.from({ length: 20 }, (_, i) => `swap-${i}`);
    const { manager, state, drain } = makeManager(swaps);

    capPollConcurrency(manager, 6);
    capPollConcurrency(manager, 6);

    const done = manager.pollAllSwaps();
    await flush();
    expect(state.maxInflight).toBe(6);

    await drain();
    await done;
  });

  it('reports false for a manager without the method rather than throwing', () => {
    expect(capPollConcurrency({}, 4)).toBe(false);
    expect(capPollConcurrency(null, 4)).toBe(false);
    expect(capPollConcurrency(undefined, 4)).toBe(false);
    expect(capPollConcurrency({ pollSingleSwap: 'not a function' }, 4)).toBe(false);
  });

  it('treats a nonsense limit as uncapped rather than deadlocking', async () => {
    const swaps = ['a', 'b', 'c'];
    const { manager, state, drain } = makeManager(swaps);

    capPollConcurrency(manager, 0);
    const done = manager.pollAllSwaps();
    await flush();
    await drain();
    await done;

    expect(state.polled.sort()).toEqual([...swaps].sort());
  });

  it('defaults to a limit that keeps a full cycle inside the 30s poll interval', () => {
    // 30s cadence, ~200ms per Boltz round trip. The default has to drain a realistic
    // monitored set well inside one interval or cycles start overlapping.
    expect(DEFAULT_POLL_CONCURRENCY).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_POLL_CONCURRENCY).toBeLessThanOrEqual(16);
  });

  it('logs nothing on the happy path', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { manager, drain } = makeManager(['a', 'b']);
    capPollConcurrency(manager, 2);
    const done = manager.pollAllSwaps();
    await flush();
    await drain();
    await done;
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
