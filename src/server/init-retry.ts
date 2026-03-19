/**
 * Retry wrapper for wallet initialization.
 *
 * When the Arkade ASP (arkade.computer) returns 503 during startup,
 * the wallet init throws. Without retry logic, the process guard treats
 * this as fatal and shuts down. On Railway with limited restart retries,
 * this leaves the service permanently stopped.
 *
 * This module provides exponential backoff retry so transient ASP
 * unavailability doesn't kill the process.
 */

export interface RetryOptions {
  maxAttempts: number;
  backoffMs: number[];
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  backoffMs: [10_000, 20_000, 40_000, 80_000, 160_000],
};

/**
 * Retry an async init function with exponential backoff.
 * Throws the last error after all attempts are exhausted.
 */
export async function initWalletWithRetry<T>(
  initFn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY_OPTIONS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await initFn();
    } catch (err) {
      lastError = err;
      console.error(
        `[init] Wallet init attempt ${attempt}/${opts.maxAttempts} failed: ${err instanceof Error ? err.message : err}`,
      );

      if (attempt < opts.maxAttempts) {
        const delay = opts.backoffMs[attempt - 1] ?? opts.backoffMs[opts.backoffMs.length - 1];
        console.log(`[init] Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
