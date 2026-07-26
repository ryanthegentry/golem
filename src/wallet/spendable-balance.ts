/**
 * Which part of a `WalletBalance` can actually be spent.
 *
 * sdk 0.4.51 split the balance into spendable and not-yet-spendable parts. `total` now
 * includes `pendingRecovery` — funds under a signer the ASP deprecated past its cutoff and
 * has not swept yet — and `recoverable` — funds already swept but not yet redeemed. The SDK
 * excludes both from `available`, from `settled`/`preconfirmed`, and from coin selection.
 *
 * Golem sized its out-of-round exposure limit from `total`, which after the 2026-07-26
 * recovery meant sizing a spend control against 34,882 sats that could not be spent. Spend
 * decisions use the spendable figure; `total` remains the right number to *report*, because
 * the money is still the wallet's.
 */

import type { WalletBalance } from '@arkade-os/sdk';

export interface OorLimitConfig {
  oorLimitFraction: number;
  oorLimitMinSats: number;
}

/**
 * Immediately spendable offchain balance.
 *
 * Prefers the SDK's `available`, which additionally excludes VTXOs locked by an in-flight
 * intent. Falls back to `settled + preconfirmed` so a partial or older balance object cannot
 * silently read as zero spendable.
 */
export function spendableSats(balance: WalletBalance): number {
  if (typeof balance.available === 'number') return balance.available;
  return (balance.settled ?? 0) + (balance.preconfirmed ?? 0);
}

/** Out-of-round exposure ceiling: a fraction of spendable funds, never below the floor. */
export function oorLimitFor(balance: WalletBalance, config: OorLimitConfig): number {
  const percentLimit = Math.floor(spendableSats(balance) * config.oorLimitFraction);
  return Math.max(percentLimit, config.oorLimitMinSats);
}
