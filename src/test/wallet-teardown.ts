import { afterEach } from 'vitest';
import type { GolemWallet } from '../wallet/golem-wallet.js';

/**
 * Dispose every real GolemWallet a test file creates.
 *
 * A real wallet holds the Ark SDK's indexer SSE subscription and the
 * VtxoManager poll timers (#10). A test that leaves one undisposed leaves a
 * vitest fork that cannot exit; on the CI runner those forks accumulate,
 * each pinning the SDK's memory, until the runner stalls and the whole run
 * freezes silently — the hang that cancelled every CI run from 2026-07-26
 * until this teardown landed. Call once at file scope, then `track(wallet)`
 * after each create.
 */
export function walletTeardown(): (wallet: GolemWallet) => void {
  const wallets: GolemWallet[] = [];
  afterEach(async () => {
    for (const w of wallets.splice(0)) {
      // an individual dispose failure must not fail an unrelated test
      await w.dispose().catch(() => {});
    }
  });
  return (wallet) => {
    wallets.push(wallet);
  };
}
