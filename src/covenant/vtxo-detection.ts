/**
 * VTXO type detection for dual-mode (cooperative + covenant) operation.
 * Determines whether a VTXO belongs to the covenant taptree or the standard SDK taptree.
 */

import { VtxoScript } from '@arkade-os/sdk';
import type { ExtendedVirtualCoin, VirtualCoin } from '@arkade-os/sdk';
import { isBlockHeight } from '../agent/expiry.js';

/**
 * Check if a VTXO belongs to the covenant taptree by comparing its decoded pkScript.
 * Returns true if the VTXO's tapTree decodes to a VtxoScript whose pkScript matches.
 */
export function isCovenantVtxo(
  vtxo: ExtendedVirtualCoin,
  covenantPkScript: Uint8Array,
): boolean {
  try {
    const decoded = VtxoScript.decode(vtxo.tapTree);
    const pk = decoded.pkScript;
    if (pk.length !== covenantPkScript.length) return false;
    for (let i = 0; i < pk.length; i++) {
      if (pk[i] !== covenantPkScript[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Partition VTXOs into covenant and standard buckets.
 */
export function partitionVtxos(
  vtxos: ExtendedVirtualCoin[],
  covenantPkScript: Uint8Array,
): { covenant: ExtendedVirtualCoin[]; standard: ExtendedVirtualCoin[] } {
  const covenant: ExtendedVirtualCoin[] = [];
  const standard: ExtendedVirtualCoin[] = [];
  for (const vtxo of vtxos) {
    if (isCovenantVtxo(vtxo, covenantPkScript)) {
      covenant.push(vtxo);
    } else {
      standard.push(vtxo);
    }
  }
  return { covenant, standard };
}

/** Average block time in ms (10 min mainnet). */
const AVG_BLOCK_TIME_MS = 10 * 60 * 1000;

/**
 * Check if a covenant VTXO is expiring within the safety margin.
 * Handles both timestamp-based and block-height-based expiries.
 */
export function isCovenantVtxoExpiring(
  vtxo: { virtualStatus: { batchExpiry?: number } },
  safetyMarginMs: number,
  currentBlockHeight?: number,
): boolean {
  const expiry = vtxo.virtualStatus?.batchExpiry;
  if (!expiry || expiry <= 0) return false;

  if (isBlockHeight(expiry)) {
    if (currentBlockHeight === undefined) return false;
    const blocksRemaining = expiry - currentBlockHeight;
    const marginBlocks = Math.ceil(safetyMarginMs / AVG_BLOCK_TIME_MS);
    return blocksRemaining > 0 && blocksRemaining < marginBlocks;
  }

  // Timestamp-based
  const remainingMs = expiry - Date.now();
  return remainingMs > 0 && remainingMs < safetyMarginMs;
}
