import type { WalletBalance } from '@arkade-os/sdk';

export function walletBalance(overrides: Partial<WalletBalance> = {}): WalletBalance {
  return {
    boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
    settled: 0,
    preconfirmed: 0,
    available: 0,
    recoverable: 0,
    // Added in sdk 0.4.51: funds under a deprecated signer past its cutoff that the server
    // has not swept yet. Not spendable until they recover, but still the wallet's money, so
    // the SDK counts them in `total` and excludes them from `available`.
    pendingRecovery: 0,
    total: 0,
    assets: [],
    ...overrides,
  };
}
