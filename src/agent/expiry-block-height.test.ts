/**
 * Tests for block-height expiry handling (RC4 fix).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isBlockHeight,
  blockHeightToRemainingMs,
  getNearestExpiryMs,
  BlockHeightFetcher,
} from './expiry.js';

describe('block-height expiry (RC4)', () => {
  describe('isBlockHeight', () => {
    it('block heights are below 1e9', () => {
      expect(isBlockHeight(800_000)).toBe(true);
      expect(isBlockHeight(1)).toBe(true);
      expect(isBlockHeight(999_999_999)).toBe(true);
    });

    it('timestamps are at or above 1e9', () => {
      expect(isBlockHeight(1_700_000_000)).toBe(false); // Unix seconds
      expect(isBlockHeight(1_700_000_000_000)).toBe(false); // Unix ms
    });

    it('zero and negative are not block heights', () => {
      expect(isBlockHeight(0)).toBe(false);
      expect(isBlockHeight(-1)).toBe(false);
    });
  });

  describe('blockHeightToRemainingMs', () => {
    it('converts remaining blocks to ms', () => {
      const remaining = blockHeightToRemainingMs(1000, 900);
      // 100 blocks * 10 min/block * 60s/min * 1000ms/s = 60_000_000ms
      expect(remaining).toBe(100 * 10 * 60 * 1000);
    });

    it('returns null for expired block height', () => {
      expect(blockHeightToRemainingMs(800, 900)).toBeNull();
      expect(blockHeightToRemainingMs(900, 900)).toBeNull();
    });

    it('supports custom block time', () => {
      // 30s block time (mutinynet)
      const remaining = blockHeightToRemainingMs(1000, 900, 30_000);
      expect(remaining).toBe(100 * 30_000);
    });
  });

  describe('getNearestExpiryMs with block heights', () => {
    it('handles block-height VTXOs when current height provided', () => {
      const vtxos = [{ batchExpiry: 1000 }]; // Block height 1000
      const result = getNearestExpiryMs(vtxos, 900);
      expect(result).toBe(100 * 10 * 60 * 1000);
    });

    it('skips block-height VTXOs when no current height', () => {
      const vtxos = [{ batchExpiry: 1000 }];
      const result = getNearestExpiryMs(vtxos);
      expect(result).toBeNull();
    });

    it('handles mixed VTXOs (block height + timestamp)', () => {
      const now = Date.now();
      const vtxos = [
        { batchExpiry: 1000 }, // Block height
        { batchExpiry: now + 3600_000 }, // Timestamp: 1 hour from now (in ms)
      ];
      // Block height: 100 blocks * 10min = 60M ms
      // Timestamp: 1 hour = 3.6M ms (closer)
      const result = getNearestExpiryMs(vtxos, 900);
      expect(result).toBeGreaterThan(3_500_000); // ~1 hour
      expect(result).toBeLessThan(4_000_000);
    });

    it('returns closest block-height expiry', () => {
      const vtxos = [
        { batchExpiry: 1000 }, // 100 blocks away
        { batchExpiry: 950 },  // 50 blocks away (closer)
      ];
      const result = getNearestExpiryMs(vtxos, 900);
      expect(result).toBe(50 * 10 * 60 * 1000);
    });
  });

  describe('BlockHeightFetcher', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('fetches block height from esplora', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('800123'),
      });

      const fetcher = new BlockHeightFetcher('https://mempool.space/api');
      const height = await fetcher.getBlockHeight();
      expect(height).toBe(800123);
    });

    it('caches block height', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('800123'),
      });

      const fetcher = new BlockHeightFetcher('https://mempool.space/api');
      await fetcher.getBlockHeight();
      await fetcher.getBlockHeight();
      expect(fetch).toHaveBeenCalledTimes(1); // Only one fetch
    });

    it('returns null on network error', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));

      const fetcher = new BlockHeightFetcher('https://mempool.space/api');
      const height = await fetcher.getBlockHeight();
      expect(height).toBeNull();
    });

    it('returns stale cache on network error', async () => {
      // First call succeeds
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('800123'),
      });

      const fetcher = new BlockHeightFetcher('https://mempool.space/api', 0); // No cache
      const height1 = await fetcher.getBlockHeight();
      expect(height1).toBe(800123);

      // Second call fails — returns stale cache
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
      const height2 = await fetcher.getBlockHeight();
      expect(height2).toBe(800123);
    });
  });
});
