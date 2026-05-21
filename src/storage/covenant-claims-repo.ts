/**
 * CovenantClaimsRepo — SQLite-backed persistence of prevTxBytes for keyless refresh.
 *
 * Golem's covenant claim handler records, for each covenant VTXO it self-solves into
 * existence, the raw unsigned Ark tx bytes that created that VTXO. Later, when the
 * refresh agent (or consolidation) needs to spend the VTXO, it reads those bytes back
 * and populates the PSBT `prevarktx` TLV (`{type: 0xde, key: 'prevarktx'}`) so the
 * Introspector can resolve OP_INSPECTINPUTSCRIPTPUBKEY at sign time.
 *
 * Without this storage the refresh path works in tests (which supply prevTxBytes inline)
 * but breaks weeks later in production. See docs/COVENANT.md and PR #63.
 *
 * Uses DELETE journal mode for Railway volume safety, matching MacaroonStore / ResponseCache.
 */

import Database from 'better-sqlite3';

export type CovenantClaimStatus = 'claimed' | 'refreshed' | 'spent';

export interface CovenantClaimRecord {
  vtxoOutpoint: string;
  prevTxBytes: Uint8Array;
  claimStatus: CovenantClaimStatus;
  claimedAt: number;
  refreshedAt: number | null;
}

interface DbRow {
  vtxo_outpoint: string;
  prev_ark_tx_bytes: Buffer;
  claim_status: CovenantClaimStatus;
  claimed_at: number;
  refreshed_at: number | null;
}

function rowToRecord(row: DbRow): CovenantClaimRecord {
  return {
    vtxoOutpoint: row.vtxo_outpoint,
    prevTxBytes: new Uint8Array(row.prev_ark_tx_bytes),
    claimStatus: row.claim_status,
    claimedAt: row.claimed_at,
    refreshedAt: row.refreshed_at,
  };
}

export class CovenantClaimsRepo {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = DELETE');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS covenant_claims (
        vtxo_outpoint     TEXT PRIMARY KEY,
        prev_ark_tx_bytes BLOB NOT NULL,
        claim_status      TEXT NOT NULL CHECK(claim_status IN ('claimed','refreshed','spent')),
        claimed_at        INTEGER NOT NULL,
        refreshed_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_covenant_claims_status ON covenant_claims(claim_status);
    `);
  }

  recordClaim(vtxoOutpoint: string, prevTxBytes: Uint8Array, claimedAt?: number): void {
    if (prevTxBytes.length === 0) {
      throw new Error('recordClaim: prevTxBytes must be non-empty');
    }
    const at = claimedAt ?? Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO covenant_claims
        (vtxo_outpoint, prev_ark_tx_bytes, claim_status, claimed_at, refreshed_at)
      VALUES (?, ?, 'claimed', ?, NULL)
    `).run(vtxoOutpoint, Buffer.from(prevTxBytes), at);
  }

  getPrevTxBytes(vtxoOutpoint: string): Uint8Array | null {
    const row = this.db.prepare(
      'SELECT prev_ark_tx_bytes FROM covenant_claims WHERE vtxo_outpoint = ?',
    ).get(vtxoOutpoint) as { prev_ark_tx_bytes: Buffer } | undefined;
    return row ? new Uint8Array(row.prev_ark_tx_bytes) : null;
  }

  get(vtxoOutpoint: string): CovenantClaimRecord | null {
    const row = this.db.prepare(
      'SELECT vtxo_outpoint, prev_ark_tx_bytes, claim_status, claimed_at, refreshed_at FROM covenant_claims WHERE vtxo_outpoint = ?',
    ).get(vtxoOutpoint) as DbRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Mark a claimed outpoint as refreshed. Silent no-op when the outpoint isn't
   * known (callers may not have a complete history of what they refresh).
   * Throws if attempting to regress from 'spent'.
   */
  markRefreshed(vtxoOutpoint: string, refreshedAt?: number): void {
    const current = this.get(vtxoOutpoint);
    if (!current) return; // silent no-op
    if (current.claimStatus === 'spent') {
      throw new Error(`markRefreshed: outpoint ${vtxoOutpoint} already spent — refusing to regress status`);
    }
    const at = refreshedAt ?? Date.now();
    this.db.prepare(
      "UPDATE covenant_claims SET claim_status = 'refreshed', refreshed_at = ? WHERE vtxo_outpoint = ?",
    ).run(at, vtxoOutpoint);
  }

  /**
   * Mark an outpoint as spent (consumed by collab-spend or unilateral exit).
   * Silent no-op when the outpoint isn't known.
   */
  markSpent(vtxoOutpoint: string): void {
    this.db.prepare(
      "UPDATE covenant_claims SET claim_status = 'spent' WHERE vtxo_outpoint = ?",
    ).run(vtxoOutpoint);
  }

  listByStatus(status: CovenantClaimStatus): CovenantClaimRecord[] {
    const rows = this.db.prepare(
      'SELECT vtxo_outpoint, prev_ark_tx_bytes, claim_status, claimed_at, refreshed_at FROM covenant_claims WHERE claim_status = ? ORDER BY claimed_at ASC',
    ).all(status) as DbRow[];
    return rows.map(rowToRecord);
  }

  countByStatus(status: CovenantClaimStatus): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM covenant_claims WHERE claim_status = ?',
    ).get(status) as { count: number };
    return row.count;
  }

  /** Delete spent records whose claimed_at predates `olderThanMs`. Returns deletion count. */
  cleanup(olderThanMs: number): number {
    const result = this.db.prepare(
      "DELETE FROM covenant_claims WHERE claim_status = 'spent' AND claimed_at < ?",
    ).run(olderThanMs);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
