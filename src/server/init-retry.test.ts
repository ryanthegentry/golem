/**
 * Bug 2: Wallet init crashes on transient ASP unavailability.
 *
 * Tests that initWalletWithRetry retries with exponential backoff
 * and only exits after all retries are exhausted.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { initWalletWithRetry } from './init-retry.js';

describe('Bug 2: Wallet init retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds after transient failures (3 fails then success)', async () => {
    vi.useFakeTimers();

    let attempt = 0;
    const initFn = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt <= 3) throw new Error('Service Unavailable');
      return { wallet: 'ok', lightning: 'ok' };
    });

    const promise = initWalletWithRetry(initFn, { maxAttempts: 5, backoffMs: [10, 20, 40, 80, 160] });

    // Advance through each backoff
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(40);

    const result = await promise;
    expect(result).toEqual({ wallet: 'ok', lightning: 'ok' });
    expect(initFn).toHaveBeenCalledTimes(4);
  });

  it('throws after all retries are exhausted', async () => {
    vi.useFakeTimers();

    const initFn = vi.fn().mockRejectedValue(new Error('Service Unavailable'));

    // Attach catch handler early to prevent unhandled rejection
    const promise = initWalletWithRetry(initFn, { maxAttempts: 5, backoffMs: [10, 20, 40, 80, 160] });
    const caughtPromise = promise.catch((e) => e);

    // Advance through all backoff periods
    for (const ms of [10, 20, 40, 80, 160]) {
      await vi.advanceTimersByTimeAsync(ms);
    }

    const error = await caughtPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Service Unavailable');
    expect(initFn).toHaveBeenCalledTimes(5);
  });

  it('backoff delays match the exponential schedule', async () => {
    vi.useFakeTimers();

    const initFn = vi.fn().mockRejectedValue(new Error('ASP down'));
    const schedule = [100, 200, 400, 800];

    // Attach catch handler early to prevent unhandled rejection
    const promise = initWalletWithRetry(initFn, { maxAttempts: 5, backoffMs: schedule });
    const caughtPromise = promise.catch(() => {});

    // After each delay, another attempt should have been made
    for (let i = 0; i < schedule.length; i++) {
      expect(initFn).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(schedule[i]);
    }

    // Final attempt (no more backoff after this)
    await vi.advanceTimersByTimeAsync(0);
    expect(initFn).toHaveBeenCalledTimes(5);

    await caughtPromise;
  });

  it('succeeds on first attempt with no delay', async () => {
    const initFn = vi.fn().mockResolvedValue({ wallet: 'ok', lightning: 'ok' });

    const start = Date.now();
    const result = await initWalletWithRetry(initFn, { maxAttempts: 5, backoffMs: [10000, 20000, 40000, 80000, 160000] });
    const elapsed = Date.now() - start;

    expect(result).toEqual({ wallet: 'ok', lightning: 'ok' });
    expect(initFn).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(100); // No delay on first success
  });
});
