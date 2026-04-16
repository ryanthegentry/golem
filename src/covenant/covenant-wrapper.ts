/**
 * Wraps standard SDK-managed VTXOs into covenant-protected VTXOs.
 * Uses wallet.settle() which requires alice's key (Phase 1 ServerSigner).
 */

import type { GolemWallet } from '../wallet/golem-wallet.js';
import type { ExtendedVirtualCoin } from '@arkade-os/sdk';

/**
 * Wrap a standard VTXO into the covenant address via settle().
 * This is a cooperative operation — requires the signer (Phase 1 hot key).
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
