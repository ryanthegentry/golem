/**
 * VTXO expiry estimation utilities.
 *
 * The Ark SDK stores batchExpiry on VTXOs in milliseconds (Unix epoch).
 * The server returns expiresAt in seconds; the SDK indexer multiplies by 1000.
 *
 * However, on regtest/mutinynet the server may return raw block heights
 * instead of Unix timestamps. The SDK's isExpired() has a heuristic that
 * treats values resulting in dates before 2025 as block heights and ignores
 * them, but isVtxoExpiringSoon() does NOT have this guard.
 *
 * This module provides utilities to detect and convert between the two
 * representations. It will be fleshed out in Step 6 (dynamic safety margins).
 */

/**
 * Threshold below which a batchExpiry value is likely a block height
 * rather than a Unix ms timestamp. 1e12 ms ≈ year 2001.
 * Any real expiry timestamp will be > 1.7e12 (year 2024+).
 */
const BLOCK_HEIGHT_THRESHOLD = 1e12;

/**
 * Returns true if the batchExpiry value looks like a block height
 * rather than a Unix millisecond timestamp.
 */
export function isBlockHeight(batchExpiry: number): boolean {
  return batchExpiry > 0 && batchExpiry < BLOCK_HEIGHT_THRESHOLD;
}

/**
 * Estimate wall-clock expiry time from a block-height-based batchExpiry.
 *
 * TODO (Step 6): Implement properly using:
 *   - Current block height from esplora API (GET /api/blocks/tip/height)
 *   - Average block interval for the network (mutinynet ≈ 30s, mainnet ≈ 600s)
 *   - Formula: expiryMs = Date.now() + (batchExpiry - currentHeight) * avgBlockIntervalMs
 *
 * @param batchExpiry - Block height at which the VTXO expires
 * @param currentBlockHeight - Current tip height
 * @param avgBlockIntervalMs - Average block interval in ms (mutinynet: 30_000, mainnet: 600_000)
 * @returns Estimated expiry as Unix ms timestamp
 */
export function estimateExpiryFromBlockHeight(
  batchExpiry: number,
  currentBlockHeight: number,
  avgBlockIntervalMs: number,
): number {
  const blocksRemaining = batchExpiry - currentBlockHeight;
  if (blocksRemaining <= 0) return Date.now(); // already expired
  return Date.now() + blocksRemaining * avgBlockIntervalMs;
}

/**
 * Estimate remaining time until VTXO expiry in milliseconds.
 *
 * Handles both timestamp-based and block-height-based batchExpiry values.
 * For block heights, falls back to a rough estimate if no block height info
 * is provided.
 *
 * TODO (Step 6): Accept a NetworkInfo parameter with current block height
 * and average interval, fetched periodically by the refresh agent.
 */
export function estimateRemainingMs(
  batchExpiry: number,
  currentBlockHeight?: number,
  avgBlockIntervalMs?: number,
): number {
  if (!isBlockHeight(batchExpiry)) {
    // batchExpiry is already a Unix ms timestamp
    return Math.max(0, batchExpiry - Date.now());
  }

  // batchExpiry is a block height — need network info to estimate
  if (currentBlockHeight !== undefined && avgBlockIntervalMs !== undefined) {
    const estimated = estimateExpiryFromBlockHeight(
      batchExpiry,
      currentBlockHeight,
      avgBlockIntervalMs,
    );
    return Math.max(0, estimated - Date.now());
  }

  // No network info available — return MAX to avoid false positives.
  // The refresh agent should fetch block height info periodically.
  return Number.MAX_SAFE_INTEGER;
}
