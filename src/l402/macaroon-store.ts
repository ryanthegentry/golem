/**
 * MacaroonStore — SQLite-backed tracking for time-based L402 macaroons.
 *
 * Provides:
 * - Anti-replay: only registered payment_hashes are accepted
 * - Monitoring: activeCount() for /l402/status endpoint
 * - Revocation: delete a row to invalidate a macaroon
 * - Audit: last_verified_at tracking
 *
 * Uses DELETE journal mode (not WAL) for Railway volume safety.
 */

import Database from 'better-sqlite3';

interface MacaroonRecord {
  paymentHash: string;
  expiresAt: number;
  priceSats: number;
  createdAt: number;
  lastVerifiedAt: number | null;
}

export class MacaroonStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = DELETE');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_macaroons (
        payment_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        price_sats INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_verified_at INTEGER
      )
    `);
  }

  /** Register a newly-paid macaroon */
  register(paymentHash: string, expiresAt: number, priceSats: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO active_macaroons (payment_hash, expires_at, price_sats)
      VALUES (?, ?, ?)
    `).run(paymentHash, expiresAt, priceSats);
  }

  /** Verify a macaroon is registered and not expired. Returns validity + expiry. */
  verify(paymentHash: string): { valid: boolean; expiresAt: number } {
    const row = this.db.prepare(
      'SELECT expires_at FROM active_macaroons WHERE payment_hash = ?'
    ).get(paymentHash) as { expires_at: number } | undefined;

    if (!row) return { valid: false, expiresAt: 0 };

    const now = Math.floor(Date.now() / 1000);
    if (now >= row.expires_at) return { valid: false, expiresAt: row.expires_at };

    // Update last_verified_at for monitoring
    this.db.prepare(
      'UPDATE active_macaroons SET last_verified_at = unixepoch() WHERE payment_hash = ?'
    ).run(paymentHash);

    return { valid: true, expiresAt: row.expires_at };
  }

  /** Count of currently-active (non-expired) macaroons */
  activeCount(): number {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM active_macaroons WHERE expires_at > ?'
    ).get(now) as { count: number };
    return row.count;
  }

  /** Cleanup: delete expired macaroons older than 7 days */
  cleanup(): number {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const result = this.db.prepare(
      'DELETE FROM active_macaroons WHERE expires_at < ?'
    ).run(sevenDaysAgo);
    return result.changes;
  }

  /** Get a specific record by payment hash */
  get(paymentHash: string): MacaroonRecord | null {
    const row = this.db.prepare(
      'SELECT payment_hash, expires_at, price_sats, created_at, last_verified_at FROM active_macaroons WHERE payment_hash = ?'
    ).get(paymentHash) as { payment_hash: string; expires_at: number; price_sats: number; created_at: number; last_verified_at: number | null } | undefined;

    if (!row) return null;

    return {
      paymentHash: row.payment_hash,
      expiresAt: row.expires_at,
      priceSats: row.price_sats,
      createdAt: row.created_at,
      lastVerifiedAt: row.last_verified_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
