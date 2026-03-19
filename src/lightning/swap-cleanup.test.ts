/**
 * Bug 1: SwapManager polls expired/purged swaps indefinitely.
 *
 * Tests that the cleanup function in createLightning() deletes terminal-state
 * swap records older than 7 days from the SQLite DB, while preserving active
 * and recent swaps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanupTerminalSwaps } from './index.js';

const TERMINAL_STATUSES = [
  'transaction.claimed',
  'transaction.refunded',
  'swap.expired',
  'invoice.expired',
];

const ACTIVE_STATUSES = [
  'swap.created',
  'transaction.mempool',
  'transaction.confirmed',
  'invoice.set',
];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function insertSwap(
  db: Database.Database,
  id: string,
  status: string,
  createdAt: number,
) {
  db.prepare(
    `INSERT INTO boltz_swaps (id, type, status, created_at, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, 'submarine', status, createdAt, JSON.stringify({ id, type: 'submarine', status, createdAt }));
}

describe('Bug 1: Swap DB cleanup', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-swap-cleanup-'));
    db = new Database(path.join(tmpDir, 'boltz-swaps.db'));
    db.pragma('journal_mode = DELETE');
    // Create the table (matches SDK schema)
    db.exec(`
      CREATE TABLE IF NOT EXISTS boltz_swaps (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes terminal-state swaps older than 7 days', () => {
    const oldTimestamp = Date.now() - SEVEN_DAYS_MS - 1000; // 7 days + 1s ago

    for (const status of TERMINAL_STATUSES) {
      insertSwap(db, `old-${status}`, status, oldTimestamp);
    }

    const deleted = cleanupTerminalSwaps(db);
    expect(deleted).toBe(4);

    const remaining = db.prepare('SELECT COUNT(*) as count FROM boltz_swaps').get() as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('preserves terminal-state swaps newer than 7 days', () => {
    const recentTimestamp = Date.now() - SEVEN_DAYS_MS + 60_000; // 7 days minus 1 minute

    for (const status of TERMINAL_STATUSES) {
      insertSwap(db, `recent-${status}`, status, recentTimestamp);
    }

    const deleted = cleanupTerminalSwaps(db);
    expect(deleted).toBe(0);

    const remaining = db.prepare('SELECT COUNT(*) as count FROM boltz_swaps').get() as { count: number };
    expect(remaining.count).toBe(4);
  });

  it('preserves active-state swaps even if older than 7 days', () => {
    const oldTimestamp = Date.now() - SEVEN_DAYS_MS - 86400_000; // 8 days ago

    for (const status of ACTIVE_STATUSES) {
      insertSwap(db, `active-${status}`, status, oldTimestamp);
    }

    const deleted = cleanupTerminalSwaps(db);
    expect(deleted).toBe(0);

    const remaining = db.prepare('SELECT COUNT(*) as count FROM boltz_swaps').get() as { count: number };
    expect(remaining.count).toBe(4);
  });

  it('handles empty database without error', () => {
    const deleted = cleanupTerminalSwaps(db);
    expect(deleted).toBe(0);
  });

  it('mixed: deletes only old terminal swaps, preserves everything else', () => {
    const oldTime = Date.now() - SEVEN_DAYS_MS - 1000;
    const recentTime = Date.now() - 3600_000; // 1 hour ago

    // Old terminal (should be deleted)
    insertSwap(db, 'old-claimed', 'transaction.claimed', oldTime);
    insertSwap(db, 'old-expired', 'swap.expired', oldTime);

    // Recent terminal (should be preserved)
    insertSwap(db, 'recent-claimed', 'transaction.claimed', recentTime);

    // Old active (should be preserved)
    insertSwap(db, 'old-active', 'swap.created', oldTime);

    // Recent active (should be preserved)
    insertSwap(db, 'recent-active', 'transaction.mempool', recentTime);

    const deleted = cleanupTerminalSwaps(db);
    expect(deleted).toBe(2);

    const remaining = db.prepare('SELECT id FROM boltz_swaps ORDER BY id').all() as { id: string }[];
    const ids = remaining.map(r => r.id).sort();
    expect(ids).toEqual(['old-active', 'recent-active', 'recent-claimed']);
  });
});
