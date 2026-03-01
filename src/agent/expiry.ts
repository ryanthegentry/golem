// batchExpiry disambiguation: block heights < 1e9, Unix seconds < 1e12, Unix ms >= 1e12.
// Regtest/mutinynet may return raw block heights instead of ms timestamps.

const BLOCK_HEIGHT_THRESHOLD = 1e9;
const MS_THRESHOLD = 1e12;

/** True if batchExpiry is a block height rather than a Unix timestamp. */
export function isBlockHeight(batchExpiry: number): boolean {
  return batchExpiry > 0 && batchExpiry < BLOCK_HEIGHT_THRESHOLD;
}

/** Normalize batchExpiry to ms. Throws on block heights — call isBlockHeight() first. */
export function normalizeExpiryMs(batchExpiry: number): number {
  if (isBlockHeight(batchExpiry)) {
    throw new Error(`normalizeExpiryMs called with block height ${batchExpiry} — filter with isBlockHeight() first`);
  }
  return batchExpiry >= MS_THRESHOLD ? batchExpiry : batchExpiry * 1000;
}

/** Extract batchExpiry from SDK VTXOs for use with getNearestExpiryMs. */
export function toExpiryInput(
  vtxos: ReadonlyArray<{ virtualStatus: { batchExpiry: number } }>,
): Array<{ batchExpiry: number }> {
  return vtxos.map(v => ({ batchExpiry: v.virtualStatus.batchExpiry }));
}

/** Smallest remaining ms until any VTXO expires, or null. Skips block-height expiries. */
export function getNearestExpiryMs(
  vtxos: ReadonlyArray<{ batchExpiry: number }>,
): number | null {
  const now = Date.now();
  let nearest: number | null = null;

  for (const vtxo of vtxos) {
    const expiry = vtxo.batchExpiry;
    if (expiry && expiry > 0 && !isBlockHeight(expiry)) {
      const remainingMs = normalizeExpiryMs(expiry) - now;
      if (remainingMs > 0 && (nearest === null || remainingMs < nearest)) {
        nearest = remainingMs;
      }
    }
  }

  return nearest;
}
