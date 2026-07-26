/**
 * Swap DB cleanup.
 *
 * Two bugs live here. The first (golem#1): SwapManager polls purged swaps forever, so
 * terminal rows older than 7 days are deleted at startup.
 *
 * The second, found 2026-07-25 in production: `boltz_swaps.created_at` is written by the SDK
 * as `Math.floor(Date.now() / 1e3)` — **seconds** — and both cleanups compared it against
 * `Date.now() - AGE_MS`, a millisecond cutoff. `1.785e9 < 1.785e12` is true for every row, so
 * each startup deleted the entire eligible set regardless of age: 14,425 terminal rows and
 * 533 "stale" pending swaps in one deploy log, the pending ones including live in-flight
 * payments. An unmonitored VHTLC eventually refunds to Boltz, so this was a fund-loss path.
 *
 * These fixtures previously inserted `Date.now()` — milliseconds — which made both sides of
 * the comparison agree and the suite pass against broken code. Fixtures are in seconds now,
 * matching the rows production actually holds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanupTerminalSwaps, cleanupStalePendingSwaps, runSwapCleanup } from './index.js';

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

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
const ONE_DAY_SEC = 24 * 60 * 60;

/** What the SDK writes: `createdAt: Math.floor(Date.now() / 1e3)`. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

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

function ids(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM boltz_swaps ORDER BY id').all() as { id: string }[])
    .map((r) => r.id);
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
    const oldTimestamp = nowSec() - SEVEN_DAYS_SEC - 1;

    for (const status of TERMINAL_STATUSES) {
      insertSwap(db, `old-${status}`, status, oldTimestamp);
    }

    const deleted = cleanupTerminalSwaps(db);
    expect(deleted).toBe(4);
    expect(ids(db)).toEqual([]);
  });

  it('preserves terminal-state swaps newer than 7 days', () => {
    const recentTimestamp = nowSec() - SEVEN_DAYS_SEC + 60; // 7 days minus 1 minute

    for (const status of TERMINAL_STATUSES) {
      insertSwap(db, `recent-${status}`, status, recentTimestamp);
    }

    const deleted = cleanupTerminalSwaps(db);
    expect(deleted).toBe(0);
    expect(ids(db).length).toBe(4);
  });

  it('preserves active-state swaps even if older than 7 days', () => {
    const oldTimestamp = nowSec() - SEVEN_DAYS_SEC - ONE_DAY_SEC; // 8 days ago

    for (const status of ACTIVE_STATUSES) {
      insertSwap(db, `active-${status}`, status, oldTimestamp);
    }

    const deleted = cleanupTerminalSwaps(db);
    expect(deleted).toBe(0);
    expect(ids(db).length).toBe(4);
  });

  it('handles empty database without error', () => {
    expect(cleanupTerminalSwaps(db)).toBe(0);
  });

  it('mixed: deletes only old terminal swaps, preserves everything else', () => {
    const oldTime = nowSec() - SEVEN_DAYS_SEC - 1;
    const recentTime = nowSec() - 3600; // 1 hour ago

    insertSwap(db, 'old-claimed', 'transaction.claimed', oldTime);
    insertSwap(db, 'old-expired', 'swap.expired', oldTime);
    insertSwap(db, 'recent-claimed', 'transaction.claimed', recentTime);
    insertSwap(db, 'old-active', 'swap.created', oldTime);
    insertSwap(db, 'recent-active', 'transaction.mempool', recentTime);

    const deleted = cleanupTerminalSwaps(db);
    expect(deleted).toBe(2);
    expect(ids(db)).toEqual(['old-active', 'recent-active', 'recent-claimed']);
  });
});

describe('Bug 2: cleanup unit mismatch (seconds vs milliseconds)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-swap-units-'));
    db = new Database(path.join(tmpDir, 'boltz-swaps.db'));
    db.pragma('journal_mode = DELETE');
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

  it('live pending swaps survive a restart cleanup', () => {
    // The whole point. These are in-flight L402 payments — an unmonitored VHTLC refunds to
    // Boltz. The production rows that exposed the bug were exactly this: three pending swaps
    // five minutes apart, matching the watchdog's challenge cadence.
    const now = nowSec();
    insertSwap(db, 'live-1', 'swap.created', now - 300);
    insertSwap(db, 'live-2', 'invoice.set', now - 600);
    insertSwap(db, 'live-3', 'transaction.mempool', now - 900);

    // Two restarts in a row must not touch them.
    expect(cleanupStalePendingSwaps(db)).toBe(0);
    expect(cleanupTerminalSwaps(db)).toBe(0);
    expect(cleanupStalePendingSwaps(db)).toBe(0);

    expect(ids(db)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('production timestamps: seconds-epoch rows are not treated as ancient', () => {
    // Verbatim from the surviving rows in production's boltz-swaps.db.
    for (const [i, createdAt] of [1785027002, 1785027301, 1785027602].entries()) {
      insertSwap(db, `prod-${i}`, 'swap.created', createdAt);
    }
    // Those are ~24h old relative to the incident, not 56,000 years old. With a millisecond
    // cutoff every one of them is "stale" and gets deleted.
    const cutoffAgeSec = nowSec() - 1785027002;
    if (cutoffAgeSec < ONE_DAY_SEC) {
      expect(cleanupStalePendingSwaps(db)).toBe(0);
      expect(ids(db).length).toBe(3);
    } else {
      // Fixture rows are genuinely older than the window now — they should all go, and the
      // count must be exact rather than "everything in the table".
      insertSwap(db, 'fresh', 'swap.created', nowSec() - 60);
      expect(cleanupStalePendingSwaps(db)).toBe(3);
      expect(ids(db)).toEqual(['fresh']);
    }
  });

  it('deletes pending swaps older than 24 hours', () => {
    const stale = nowSec() - ONE_DAY_SEC - 60;
    for (const status of ACTIVE_STATUSES) {
      insertSwap(db, `stale-${status}`, status, stale);
    }
    expect(cleanupStalePendingSwaps(db)).toBe(4);
    expect(ids(db)).toEqual([]);
  });

  it('leaves terminal swaps to the terminal cleanup, whatever their age', () => {
    const stale = nowSec() - SEVEN_DAYS_SEC - 60;
    for (const status of TERMINAL_STATUSES) {
      insertSwap(db, `t-${status}`, status, stale);
    }
    expect(cleanupStalePendingSwaps(db)).toBe(0);
    expect(ids(db).length).toBe(4);
  });

  it('a pending swap one minute inside the window survives; one minute outside does not', () => {
    insertSwap(db, 'inside', 'swap.created', nowSec() - ONE_DAY_SEC + 60);
    insertSwap(db, 'outside', 'swap.created', nowSec() - ONE_DAY_SEC - 60);

    expect(cleanupStalePendingSwaps(db)).toBe(1);
    expect(ids(db)).toEqual(['inside']);
  });

  it('a terminal swap one minute inside the 7-day window survives', () => {
    insertSwap(db, 'inside', 'transaction.claimed', nowSec() - SEVEN_DAYS_SEC + 60);
    insertSwap(db, 'outside', 'transaction.claimed', nowSec() - SEVEN_DAYS_SEC - 60);

    expect(cleanupTerminalSwaps(db)).toBe(1);
    expect(ids(db)).toEqual(['inside']);
  });

  it('a millisecond-valued row is left alone rather than mass-deleted', () => {
    // If a row ever lands in milliseconds, the seconds cutoff makes it look like the far
    // future and it is skipped. Wrong-but-harmless beats deleting a live swap.
    insertSwap(db, 'ms-row', 'swap.created', Date.now());
    expect(cleanupStalePendingSwaps(db)).toBe(0);
    expect(ids(db)).toEqual(['ms-row']);
  });
});

describe('RC3: cleanup on the hourly interval', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-swap-hourly-'));
    db = new Database(path.join(tmpDir, 'boltz-swaps.db'));
    db.pragma('journal_mode = DELETE');
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

  it('runs both cleanups and reports each count', () => {
    insertSwap(db, 'old-terminal', 'transaction.claimed', nowSec() - SEVEN_DAYS_SEC - 60);
    insertSwap(db, 'old-pending', 'swap.created', nowSec() - ONE_DAY_SEC - 60);
    insertSwap(db, 'live', 'swap.created', nowSec() - 60);

    expect(runSwapCleanup(db)).toEqual({ terminal: 1, stalePending: 1 });
    expect(ids(db)).toEqual(['live']);
  });

  it('an hourly tick against a clean DB deletes nothing', () => {
    insertSwap(db, 'live-1', 'swap.created', nowSec() - 60);
    insertSwap(db, 'recent-terminal', 'transaction.claimed', nowSec() - 3600);

    for (let hour = 0; hour < 3; hour += 1) {
      expect(runSwapCleanup(db)).toEqual({ terminal: 0, stalePending: 0 });
    }
    expect(ids(db)).toEqual(['live-1', 'recent-terminal']);
  });

  it('returns null instead of throwing when the table is missing', () => {
    db.exec('DROP TABLE boltz_swaps');
    expect(runSwapCleanup(db)).toBeNull();
  });

  it('returns null when there is no swap DB', () => {
    expect(runSwapCleanup(null)).toBeNull();
  });
});
