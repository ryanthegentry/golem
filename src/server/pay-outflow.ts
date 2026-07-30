/**
 * Persisted daily-outflow ledger for the Lightning payer route.
 *
 * The per-day cap only means anything if it survives a restart. An in-memory counter resets
 * on every Railway deploy, which quietly converts "10,000 sats per day" into "10,000 sats per
 * deploy" — and deploys are cheap for anyone holding the key. So the counter lives on the same
 * volume as the rest of the wallet state, keyed by UTC day.
 *
 * It fails CLOSED. An unreadable or corrupt ledger throws rather than reporting zero spent
 * (red-team 2026-07-29, HIGH-004): corruption has two causes, disk trouble and tampering, and
 * both are reasons to stop spending. The asymmetry decides it — failing closed costs a bounded
 * outage of a route the router can retry later, failing open costs the entire daily cap. This
 * is the same "failing to remember a spend is a reason not to spend" rule the write path uses.
 *
 * INVARIANTS (both load-bearing; see red-team MEDIUM-004):
 *  1. Exactly one process owns this file. There is no lock.
 *  2. The route's check-and-reserve must stay free of `await` between `spentToday()` and
 *     `record()`, so Node's single-threaded loop makes it atomic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const OUTFLOW_FILE = 'pay-outflow.json';

/** Distinguishable so the route can answer 503 rather than treating it as "nothing spent". */
export class OutflowLedgerUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutflowLedgerUnreadableError';
  }
}

export interface OutflowLedger {
  /** Sats committed today (UTC). Zero on a new day or a fresh dir. Throws if unreadable. */
  spentToday(): number;
  /** Add to today's total and persist. Throws if the ledger is unreadable or unwritable. */
  record(sats: number): void;
  /** Give headroom back after a provably-clean failure. Never drives the counter negative. */
  release(sats: number): void;
}

interface OutflowRecord {
  day: string;
  spentSats: number;
}

/** UTC, not local: the cap has to mean the same thing regardless of where the container runs. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createOutflowLedger(dir: string): OutflowLedger {
  const file = path.join(dir, OUTFLOW_FILE);

  function read(): OutflowRecord {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // Absent is the ordinary first-boot state and must not disable spending. Anything else
      // (permissions, I/O error) is a real read failure and does.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { day: utcDay(), spentSats: 0 };
      }
      throw new OutflowLedgerUnreadableError(
        `${file} could not be read (${err instanceof Error ? err.message : err}) — spending disabled`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new OutflowLedgerUnreadableError(
        `${file} is not valid JSON (${err instanceof Error ? err.message : err}) — spending disabled`,
      );
    }

    const record = parsed as Partial<OutflowRecord> | null;
    if (
      typeof record?.day !== 'string' ||
      typeof record?.spentSats !== 'number' ||
      !Number.isFinite(record.spentSats)
    ) {
      throw new OutflowLedgerUnreadableError(
        `${file} is not a { day: string, spentSats: number } record — spending disabled`,
      );
    }

    return { day: record.day, spentSats: record.spentSats };
  }

  /**
   * Write-then-rename, so a reader never sees a truncated document — which would be
   * indistinguishable from "nothing spent today" and would hand back the whole cap.
   *
   * The temp name carries pid and timestamp: a fixed `.tmp` path lets two writers (deploy
   * overlap, or a replica) clobber each other's partial files and rename the wrong one.
   * fsync before the rename, and on the directory after, so the rename is durable across a
   * crash rather than merely ordered — this volume is network-attached.
   */
  function writeRecord(next: OutflowRecord): void {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(next));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }

    // Durability of the rename itself. Not supported on every platform; a failure here means
    // the data is written but the directory entry may not survive a power cut, which is not
    // worth failing a payment over.
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* best effort */ }
  }

  /** Today's total, treating a stale day as zero without rewriting the file. */
  function baseForToday(): number {
    const current = read();
    return current.day === utcDay() ? current.spentSats : 0;
  }

  return {
    spentToday(): number {
      return baseForToday();
    },

    record(sats: number): void {
      writeRecord({ day: utcDay(), spentSats: baseForToday() + sats });
    },

    release(sats: number): void {
      writeRecord({ day: utcDay(), spentSats: Math.max(0, baseForToday() - sats) });
    },
  };
}
