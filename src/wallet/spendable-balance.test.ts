/**
 * Spendable balance vs total, after sdk 0.4.51.
 *
 * `WalletBalance.total` now includes `pendingRecovery` — funds under a signer the ASP has
 * deprecated past its cutoff, which the server has not swept yet. The SDK is explicit that
 * these are "NOT spendable until they recover, so excluded from available/settled/preconfirmed
 * and from coin selection — but still the wallet's funds, so counted in total."
 *
 * Golem derived its out-of-round exposure limit from `total`, so on 2026-07-26 the limit was
 * being computed against 34,882 sats that could not be spent. A spend control sized from
 * unspendable money is wrong in the unsafe direction, so it moves to the spendable figure.
 */

import { describe, it, expect } from 'vitest';
import { spendableSats, oorLimitFor } from './spendable-balance.js';
import { walletBalance } from '../test/wallet-balance.js';

describe('spendableSats', () => {
  it('is the SDK\'s available figure, not total', () => {
    const b = walletBalance({ available: 5_000, pendingRecovery: 34_882, total: 39_882 });
    expect(spendableSats(b)).toBe(5_000);
  });

  it('excludes pendingRecovery — the 2026-07-26 case', () => {
    const b = walletBalance({ available: 0, pendingRecovery: 34_882, total: 34_882 });
    expect(spendableSats(b)).toBe(0);
  });

  it('excludes recoverable funds too — swept, not yet redeemed', () => {
    const b = walletBalance({ available: 0, recoverable: 34_882, total: 34_882 });
    expect(spendableSats(b)).toBe(0);
  });

  it('falls back to settled + preconfirmed when available is absent', () => {
    // Defensive: an older or partial balance object must not read as zero spendable.
    const b = { settled: 700, preconfirmed: 300 } as never;
    expect(spendableSats(b)).toBe(1_000);
  });
});

describe('oorLimitFor', () => {
  const cfg = { oorLimitFraction: 0.1, oorLimitMinSats: 1_000 };

  it('sizes the limit from spendable funds, not total', () => {
    const b = walletBalance({ available: 100_000, pendingRecovery: 900_000, total: 1_000_000 });
    // 10% of 100_000 spendable, not of the 1_000_000 total.
    expect(oorLimitFor(b, cfg)).toBe(10_000);
  });

  it('never sizes the limit from funds pending recovery', () => {
    const withPending = walletBalance({ available: 100_000, pendingRecovery: 900_000, total: 1_000_000 });
    const withoutPending = walletBalance({ available: 100_000, pendingRecovery: 0, total: 100_000 });
    expect(oorLimitFor(withPending, cfg)).toBe(oorLimitFor(withoutPending, cfg));
  });

  it('keeps the configured floor', () => {
    const b = walletBalance({ available: 0, total: 0 });
    expect(oorLimitFor(b, cfg)).toBe(1_000);
  });

  it('floor wins when the percentage is smaller', () => {
    const b = walletBalance({ available: 5_000, total: 5_000 });
    expect(oorLimitFor(b, cfg)).toBe(1_000); // 10% = 500, floor is 1_000
  });

  it('percentage wins when it exceeds the floor', () => {
    const b = walletBalance({ available: 500_000, total: 500_000 });
    expect(oorLimitFor(b, cfg)).toBe(50_000);
  });

  it('rounds down rather than up', () => {
    const b = walletBalance({ available: 10_009, total: 10_009 });
    expect(oorLimitFor(b, { oorLimitFraction: 0.1, oorLimitMinSats: 0 })).toBe(1_000);
  });
});
