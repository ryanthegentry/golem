// batchExpiry disambiguation: block heights < 1e9, Unix seconds < 1e12, Unix ms >= 1e12.
// Regtest/mutinynet may return raw block heights instead of ms timestamps.

const BLOCK_HEIGHT_THRESHOLD = 1e9;
const MS_THRESHOLD = 1e12;

/** Average block time in ms (10 minutes for mainnet, ~30s for mutinynet/regtest). */
const AVG_BLOCK_TIME_MS = 10 * 60 * 1000;

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

/**
 * Convert a block-height expiry to approximate ms remaining, given current block height.
 * Returns null if the VTXO has already expired.
 */
export function blockHeightToRemainingMs(
  expiryBlock: number,
  currentBlockHeight: number,
  avgBlockTimeMs: number = AVG_BLOCK_TIME_MS,
): number | null {
  const blocksRemaining = expiryBlock - currentBlockHeight;
  if (blocksRemaining <= 0) return null;
  return blocksRemaining * avgBlockTimeMs;
}

/**
 * Smallest remaining ms until any VTXO expires, or null.
 * Handles both timestamp-based and block-height-based expiries.
 */
export function getNearestExpiryMs(
  vtxos: ReadonlyArray<{ batchExpiry: number }>,
  currentBlockHeight?: number,
): number | null {
  const now = Date.now();
  let nearest: number | null = null;

  for (const vtxo of vtxos) {
    const expiry = vtxo.batchExpiry;
    if (!expiry || expiry <= 0) continue;

    let remainingMs: number | null = null;

    if (isBlockHeight(expiry)) {
      if (currentBlockHeight !== undefined) {
        remainingMs = blockHeightToRemainingMs(expiry, currentBlockHeight);
      }
      // Skip block-height expiries if we don't have current height
    } else {
      remainingMs = normalizeExpiryMs(expiry) - now;
    }

    if (remainingMs !== null && remainingMs > 0 && (nearest === null || remainingMs < nearest)) {
      nearest = remainingMs;
    }
  }

  return nearest;
}

/**
 * Cached block height fetcher. Caches result for `cacheDurationMs` (default 60s).
 */
export class BlockHeightFetcher {
  private cached: { height: number; fetchedAt: number } | null = null;
  private readonly cacheDurationMs: number;
  private readonly esploraUrl: string;

  constructor(esploraUrl: string, cacheDurationMs: number = 60_000) {
    this.esploraUrl = esploraUrl;
    this.cacheDurationMs = cacheDurationMs;
  }

  async getBlockHeight(): Promise<number | null> {
    const now = Date.now();
    if (this.cached && now - this.cached.fetchedAt < this.cacheDurationMs) {
      return this.cached.height;
    }

    try {
      const res = await fetch(`${this.esploraUrl}/blocks/tip/height`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return this.cached?.height ?? null;
      const text = await res.text();
      const height = parseInt(text.trim(), 10);
      if (isNaN(height)) return this.cached?.height ?? null;
      this.cached = { height, fetchedAt: now };
      return height;
    } catch {
      // Network error — return stale cache if available
      return this.cached?.height ?? null;
    }
  }
}
