import { describe, it, expect, vi, afterEach } from 'vitest';
import { isBlockHeight, normalizeExpiryMs, getNearestExpiryMs } from './expiry.js';

describe('expiry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── isBlockHeight ──────────────────────────────────────────────────

  describe('isBlockHeight', () => {
    it('returns true for typical block heights', () => {
      expect(isBlockHeight(800_000)).toBe(true);
      expect(isBlockHeight(1)).toBe(true);
      expect(isBlockHeight(999_999_999)).toBe(true);
    });

    it('returns false for Unix timestamps in seconds', () => {
      // Feb 2026 in seconds: ~1_772_000_000
      expect(isBlockHeight(1_772_000_000)).toBe(false);
    });

    it('returns false for Unix timestamps in milliseconds', () => {
      expect(isBlockHeight(1_772_000_000_000)).toBe(false);
    });

    it('returns false for zero or negative', () => {
      expect(isBlockHeight(0)).toBe(false);
      expect(isBlockHeight(-1)).toBe(false);
    });
  });

  // ─── normalizeExpiryMs ─────────────────────────────────────────────

  describe('normalizeExpiryMs', () => {
    it('returns value as-is if already in milliseconds', () => {
      const msTimestamp = 1_772_000_000_000; // >= 1e12
      expect(normalizeExpiryMs(msTimestamp)).toBe(msTimestamp);
    });

    it('converts seconds to milliseconds', () => {
      const secTimestamp = 1_772_000_000; // >= 1e9 but < 1e12
      expect(normalizeExpiryMs(secTimestamp)).toBe(secTimestamp * 1000);
    });

    it('throws on block height input', () => {
      expect(() => normalizeExpiryMs(800_000)).toThrow('block height');
    });
  });

  // ─── getNearestExpiryMs ────────────────────────────────────────────

  describe('getNearestExpiryMs', () => {
    it('returns null for empty array', () => {
      expect(getNearestExpiryMs([])).toBeNull();
    });

    it('returns null when all VTXOs have block-height expiries', () => {
      const vtxos = [
        { batchExpiry: 800_000 },
        { batchExpiry: 900_000 },
      ];
      expect(getNearestExpiryMs(vtxos)).toBeNull();
    });

    it('returns null when all VTXOs have zero expiry', () => {
      const vtxos = [{ batchExpiry: 0 }];
      expect(getNearestExpiryMs(vtxos)).toBeNull();
    });

    it('returns nearest remaining ms for timestamp-based expiries', () => {
      vi.useFakeTimers();
      const now = Date.now();

      const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
      const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;

      const vtxos = [
        { batchExpiry: now + fiveDaysMs }, // ms timestamp
        { batchExpiry: now + twoDaysMs },  // ms timestamp, closer
      ];

      const nearest = getNearestExpiryMs(vtxos);
      expect(nearest).not.toBeNull();
      // Should be close to 2 days (allow small tolerance)
      expect(nearest!).toBeGreaterThan(twoDaysMs - 100);
      expect(nearest!).toBeLessThanOrEqual(twoDaysMs);
    });

    it('handles seconds-based expiries correctly', () => {
      vi.useFakeTimers();
      const now = Date.now();
      const threeDaysSec = 3 * 24 * 60 * 60;
      const expiryInSeconds = Math.floor(now / 1000) + threeDaysSec;

      const vtxos = [{ batchExpiry: expiryInSeconds }];
      const nearest = getNearestExpiryMs(vtxos);

      expect(nearest).not.toBeNull();
      const threeDaysMs = threeDaysSec * 1000;
      expect(nearest!).toBeGreaterThan(threeDaysMs - 1000);
      expect(nearest!).toBeLessThanOrEqual(threeDaysMs);
    });

    it('skips already-expired VTXOs', () => {
      vi.useFakeTimers();
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      const vtxos = [
        { batchExpiry: now - oneDayMs },   // already expired
        { batchExpiry: now + oneDayMs * 3 }, // 3 days from now
      ];

      const nearest = getNearestExpiryMs(vtxos);
      expect(nearest).not.toBeNull();
      expect(nearest!).toBeGreaterThan(oneDayMs * 2);
    });

    it('returns null when all VTXOs are expired', () => {
      vi.useFakeTimers();
      const now = Date.now();
      const vtxos = [
        { batchExpiry: now - 1000 },
        { batchExpiry: now - 5000 },
      ];

      expect(getNearestExpiryMs(vtxos)).toBeNull();
    });

    it('skips block-height expiries and returns nearest timestamp-based', () => {
      vi.useFakeTimers();
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      const vtxos = [
        { batchExpiry: 800_000 },            // block height — skipped
        { batchExpiry: now + oneDayMs * 2 },  // 2 days
      ];

      const nearest = getNearestExpiryMs(vtxos);
      expect(nearest).not.toBeNull();
      expect(nearest!).toBeGreaterThan(oneDayMs);
    });
  });
});
