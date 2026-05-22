/**
 * Wraps standard SDK-managed VTXOs into covenant-protected VTXOs.
 * Uses wallet.settle() which requires alice's key (Phase 1 ServerSigner).
 *
 * @deprecated DEPRECATED ON PATH B — Remove once Boltz ships covenant-claim
 * as swap contract (confirmed by Ark Labs as next-on-list after
 * Arkade prod migration). Path B lets the Introspector claim the reverse-swap
 * VHTLC directly into the covenant address with zero keys, eliminating this
 * wrap step and the LAST remaining ServerSigner hot-key dependency in
 * Golem's receive flow. Do NOT build additional functionality on this
 * module — the whole file should delete cleanly when Path B integrates.
 *
 * Tier taxonomy:
 *   - Tier 0.5 (current): Boltz delivers standard VHTLC → ServerSigner claim
 *     → wrapVtxoIntoCovenant() settles into covenant address (uses hot key)
 *   - Tier 1.5 (target):  Boltz delivers covenant-restricted VHTLC →
 *     Introspector claims directly into covenant address (zero keys)
 *
 * Removal trigger: `@arkade-os/boltz-swap` exposes a `claimCovenant` /
 * `claimLeaves` field on `/v2/swap/reverse` and the claim daemon auto-routes
 * covenant-VHTLCs through the keyless Introspector path.
 */

import type { GolemWallet } from '../wallet/golem-wallet.js';
import type { ExtendedVirtualCoin } from '@arkade-os/sdk';

/**
 * Wrap a standard VTXO into the covenant address via settle().
 * This is a cooperative operation — requires the signer (Phase 1 hot key).
 *
 * @deprecated This function is the ONLY remaining private-key-using code
 * path in Golem's receive flow. Use Path B once Boltz ships covenant-claim.
 */
export async function wrapVtxoIntoCovenant(
  wallet: GolemWallet,
  vtxo: ExtendedVirtualCoin,
  covenantAddress: string,
): Promise<string> {
  return wallet.settle({
    inputs: [vtxo],
    outputs: [{ address: covenantAddress, amount: BigInt(vtxo.value) }],
  });
}
