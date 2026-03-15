/**
 * ResponseCache tests — pure cache module, no gateway coupling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ResponseCache, type CacheEntry } from './response-cache.js';

let tmpDir: string;
let cache: ResponseCache;

function makeCacheEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    upstreamUrl: 'http://localhost:11434/api/generate',
    requestMethod: 'POST',
    requestBodyHash: 'abc123',
    responseStatus: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: Buffer.from('{"response":"hello"}'),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-cache-test-'));
  cache = new ResponseCache(path.join(tmpDir, 'cache.db'));
});

afterEach(() => {
  cache.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('ResponseCache', () => {
  // --- computeKey ---

  it('computes deterministic cache key from url + method + body', () => {
    const key1 = cache.computeKey('http://example.com/api', 'POST', '{"prompt":"hello"}');
    const key2 = cache.computeKey('http://example.com/api', 'POST', '{"prompt":"hello"}');
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it('different inputs produce different cache keys', () => {
    const key1 = cache.computeKey('http://example.com/api', 'POST', '{"prompt":"hello"}');
    const key2 = cache.computeKey('http://example.com/api', 'POST', '{"prompt":"world"}');
    const key3 = cache.computeKey('http://example.com/other', 'POST', '{"prompt":"hello"}');
    const key4 = cache.computeKey('http://example.com/api', 'GET', '');
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).not.toBe(key4);
  });

  // --- put / get ---

  it('stores and retrieves a cached response', () => {
    const key = 'test-key-1';
    const entry = makeCacheEntry();
    cache.put(key, entry, 3600);

    const result = cache.get(key);
    expect(result).not.toBeNull();
    expect(result!.cacheKey).toBe(key);
    expect(result!.upstreamUrl).toBe(entry.upstreamUrl);
    expect(result!.responseStatus).toBe(200);
    expect(result!.responseHeaders).toEqual({ 'content-type': 'application/json' });
    expect(result!.responseBody.toString()).toBe('{"response":"hello"}');
    expect(result!.hitCount).toBe(1);
  });

  it('returns null for missing cache key', () => {
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('returns null for expired cache entry', () => {
    vi.useFakeTimers();
    const key = 'expired-key';
    cache.put(key, makeCacheEntry(), 1); // 1 second TTL

    // Advance past expiry
    vi.setSystemTime(Date.now() + 2000);
    expect(cache.get(key)).toBeNull();
  });

  it('increments hit count on each get', () => {
    const key = 'hit-counter';
    cache.put(key, makeCacheEntry(), 3600);

    cache.get(key); // hit 1
    cache.get(key); // hit 2
    const result = cache.get(key); // hit 3
    expect(result!.hitCount).toBe(3);
  });

  it('overwrites existing entry with same key', () => {
    const key = 'overwrite-key';
    cache.put(key, makeCacheEntry({ responseStatus: 200 }), 3600);
    cache.put(key, makeCacheEntry({ responseStatus: 201 }), 3600);

    const result = cache.get(key);
    expect(result!.responseStatus).toBe(201);
    expect(result!.hitCount).toBe(1); // reset on overwrite
  });

  // --- FIFO eviction ---

  it('evicts oldest entries when at maxSize', () => {
    const smallCache = new ResponseCache(path.join(tmpDir, 'small.db'), { maxSize: 3 });

    smallCache.put('key-1', makeCacheEntry(), 3600);
    smallCache.put('key-2', makeCacheEntry(), 3600);
    smallCache.put('key-3', makeCacheEntry(), 3600);

    // Adding 4th should evict key-1
    smallCache.put('key-4', makeCacheEntry(), 3600);

    expect(smallCache.get('key-1')).toBeNull();
    expect(smallCache.get('key-2')).not.toBeNull();
    expect(smallCache.get('key-4')).not.toBeNull();
    expect(smallCache.stats().totalEntries).toBe(3);

    smallCache.close();
  });

  // --- prune ---

  it('prune deletes expired entries and returns count', () => {
    vi.useFakeTimers();
    cache.put('live', makeCacheEntry(), 3600);
    cache.put('dying-1', makeCacheEntry(), 1);
    cache.put('dying-2', makeCacheEntry(), 1);

    vi.setSystemTime(Date.now() + 2000);
    const pruned = cache.prune();
    expect(pruned).toBe(2);
    expect(cache.get('live')).not.toBeNull();
  });

  it('prune returns 0 when nothing to prune', () => {
    cache.put('live', makeCacheEntry(), 3600);
    expect(cache.prune()).toBe(0);
  });

  // --- stats ---

  it('returns accurate stats', () => {
    cache.put('s1', makeCacheEntry(), 3600);
    cache.put('s2', makeCacheEntry(), 3600);
    cache.get('s1'); // 1 hit
    cache.get('s1'); // 2 hits
    cache.recordEarnings('s1', 5);
    cache.recordEarnings('s2', 3);

    const s = cache.stats();
    expect(s.totalEntries).toBe(2);
    expect(s.totalHits).toBe(2);
    expect(s.totalSatsEarned).toBe(8);
    expect(s.oldestEntry).not.toBeNull();
    expect(s.newestEntry).not.toBeNull();
  });

  it('returns empty stats for empty cache', () => {
    const s = cache.stats();
    expect(s.totalEntries).toBe(0);
    expect(s.totalHits).toBe(0);
    expect(s.totalSatsEarned).toBe(0);
    expect(s.oldestEntry).toBeNull();
    expect(s.newestEntry).toBeNull();
  });

  // --- recordEarnings ---

  it('accumulates earnings for a cache key', () => {
    cache.put('earn-key', makeCacheEntry(), 3600);
    cache.recordEarnings('earn-key', 10);
    cache.recordEarnings('earn-key', 5);

    const result = cache.get('earn-key');
    expect(result!.totalSatsEarned).toBe(15);
  });

  it('recordEarnings is no-op for missing key', () => {
    // Should not throw
    cache.recordEarnings('missing', 100);
  });

  // --- binary data ---

  it('handles binary response bodies', () => {
    const key = 'binary-key';
    const binaryData = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
    cache.put(key, makeCacheEntry({ responseBody: binaryData }), 3600);

    const result = cache.get(key);
    expect(result!.responseBody).toEqual(binaryData);
  });

  // --- persistence ---

  it('data survives close and reopen', () => {
    const dbPath = path.join(tmpDir, 'persist.db');
    const cache1 = new ResponseCache(dbPath);
    cache1.put('persist-key', makeCacheEntry(), 3600);
    cache1.recordEarnings('persist-key', 42);
    cache1.close();

    const cache2 = new ResponseCache(dbPath);
    const result = cache2.get('persist-key');
    expect(result).not.toBeNull();
    expect(result!.totalSatsEarned).toBe(42);
    cache2.close();
  });
});
