import type { WalletBalance } from '@arkade-os/sdk';

export function walletBalance(overrides: Partial<WalletBalance> = {}): WalletBalance {
  return {
    boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
    settled: 0,
    preconfirmed: 0,
    available: 0,
    recoverable: 0,
    total: 0,
    assets: [],
    ...overrides,
  };
}
