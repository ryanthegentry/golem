/**
 * ResponseCache — SQLite-backed HTTP response cache for L402 gateway.
 *
 * Caches upstream responses so subsequent requesters pay a reduced price.
 * Gateway operator earns the spread between full price and cache price.
 *
 * Uses DELETE journal mode (consistent with macaroon-store, safe for Railway volumes).
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export interface CachedResponse {
  cacheKey: string;
  upstreamUrl: string;
  requestMethod: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: Buffer;
  cachedAt: number;
  expiresAt: number;
  hitCount: number;
  totalSatsEarned: number;
}

export interface CacheEntry {
  upstreamUrl: string;
  requestMethod: string;
  requestBodyHash: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: Buffer;
}

export interface CacheStats {
  totalEntries: number;
  totalHits: number;
  totalSatsEarned: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}

export class ResponseCache {
  private db: Database.Database;
  private readonly maxSize: number;

  constructor(dbPath: string, opts?: { maxSize?: number }) {
    this.maxSize = opts?.maxSize ?? 10_000;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = DELETE');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS response_cache (
        cache_key TEXT PRIMARY KEY,
        upstream_url TEXT NOT NULL,
        request_method TEXT NOT NULL,
        request_body_hash TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_headers TEXT NOT NULL,
        response_body BLOB NOT NULL,
        cached_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        hit_count INTEGER DEFAULT 0,
        total_sats_earned INTEGER DEFAULT 0
      )
    `);
  }

  /** Compute a deterministic cache key from request properties. */
  computeKey(url: string, method: string, body: string): string {
    return createHash('sha256')
      .update(url)
      .update(method)
      .update(body)
      .digest('hex');
  }

  /** Get a cached response. Returns null if expired or missing. Increments hit_count on hit. */
  get(cacheKey: string): CachedResponse | null {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(
      'SELECT * FROM response_cache WHERE cache_key = ? AND expires_at > ?'
    ).get(cacheKey, now) as any | undefined;

    if (!row) return null;

    // Increment hit count
    this.db.prepare(
      'UPDATE response_cache SET hit_count = hit_count + 1 WHERE cache_key = ?'
    ).run(cacheKey);

    return {
      cacheKey: row.cache_key,
      upstreamUrl: row.upstream_url,
      requestMethod: row.request_method,
      responseStatus: row.response_status,
      responseHeaders: JSON.parse(row.response_headers),
      responseBody: Buffer.from(row.response_body),
      cachedAt: row.cached_at,
      expiresAt: row.expires_at,
      hitCount: row.hit_count + 1, // reflect the increment we just did
      totalSatsEarned: row.total_sats_earned,
    };
  }

  /** Store a response in the cache. Evicts oldest entries (FIFO) if at maxSize. */
  put(cacheKey: string, entry: CacheEntry, ttlSeconds: number): void {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttlSeconds;

    // Evict oldest entries if at capacity
    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM response_cache').get() as { count: number };
    if (countRow.count >= this.maxSize) {
      const toEvict = countRow.count - this.maxSize + 1;
      this.db.prepare(
        'DELETE FROM response_cache WHERE cache_key IN (SELECT cache_key FROM response_cache ORDER BY cached_at ASC LIMIT ?)'
      ).run(toEvict);
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO response_cache
        (cache_key, upstream_url, request_method, request_body_hash, response_status, response_headers, response_body, cached_at, expires_at, hit_count, total_sats_earned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run(
      cacheKey,
      entry.upstreamUrl,
      entry.requestMethod,
      entry.requestBodyHash,
      entry.responseStatus,
      JSON.stringify(entry.responseHeaders),
      entry.responseBody,
      now,
      expiresAt,
    );
  }

  /** Delete expired entries. Returns count of pruned entries. */
  prune(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare('DELETE FROM response_cache WHERE expires_at <= ?').run(now);
    return result.changes;
  }

  /** Get cache statistics. */
  stats(): CacheStats {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_entries,
        COALESCE(SUM(hit_count), 0) as total_hits,
        COALESCE(SUM(total_sats_earned), 0) as total_sats_earned,
        MIN(cached_at) as oldest_entry,
        MAX(cached_at) as newest_entry
      FROM response_cache
    `).get() as any;

    return {
      totalEntries: row.total_entries,
      totalHits: row.total_hits,
      totalSatsEarned: row.total_sats_earned,
      oldestEntry: row.oldest_entry ?? null,
      newestEntry: row.newest_entry ?? null,
    };
  }

  /** Record sats earned from a cache hit. */
  recordEarnings(cacheKey: string, sats: number): void {
    this.db.prepare(
      'UPDATE response_cache SET total_sats_earned = total_sats_earned + ? WHERE cache_key = ?'
    ).run(sats, cacheKey);
  }

  close(): void {
    this.db.close();
  }
}
