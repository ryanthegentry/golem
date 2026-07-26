/**
 * Balance-change classification.
 *
 * On 2026-07-25 the production wallet went from 34,882 sats to 0 across a deploy and nothing
 * screamed. It took a human noticing a dashboard. The diagnostic that cracked it is the same
 * one worth automating: *"a wallet funded 20 minutes earlier should still show the receive.
 * Spends don't erase history."*
 *
 * So the invariant is not "the balance fell" — auto-sweep and ordinary sends do that legitimately
 * — it is **the balance fell while transaction history did not grow**. That separates spending
 * money from losing sight of it.
 *
 * The same classifier also names recovery progress, so the 2026-07-29 sweep is observable:
 * pendingRecovery falls, recoverable rises, then spendable rises.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyBalanceChange,
  readBalanceSnapshot,
  writeBalanceSnapshot,
  readRecoveryState,
  writeRecoveryState,
  BALANCE_SNAPSHOT_FILE,
  DEFAULT_DROP_FRACTION,
} from './balance-monitor.js';

const snap = (o: Partial<{ total: number; spendable: number; pendingRecovery: number; recoverable: number; txCount: number }>) => ({
  total: 0, spendable: 0, pendingRecovery: 0, recoverable: 0, txCount: 0, ...o,
});

describe('classifyBalanceChange — funds vanishing', () => {
  it('flags the 2026-07-25 incident: balance to zero with no new history', () => {
    const before = snap({ total: 34_882, spendable: 34_882, txCount: 12 });
    const after = snap({ total: 0, spendable: 0, txCount: 12 });
    const r = classifyBalanceChange(before, after);
    expect(r.kind).toBe('funds-vanished');
    expect(r.severity).toBe('error');
    expect(r.droppedSats).toBe(34_882);
  });

  it('does NOT flag a spend — history grew', () => {
    const before = snap({ total: 34_882, spendable: 34_882, txCount: 12 });
    const after = snap({ total: 1_000, spendable: 1_000, txCount: 13 });
    expect(classifyBalanceChange(before, after).kind).toBe('spend');
  });

  it('does not flag a drop smaller than the threshold', () => {
    const before = snap({ total: 100_000, spendable: 100_000, txCount: 5 });
    const after = snap({ total: 99_999, spendable: 99_999, txCount: 5 });
    expect(classifyBalanceChange(before, after).kind).toBe('steady');
  });

  it('flags a large partial disappearance, not just a total wipe', () => {
    const before = snap({ total: 100_000, spendable: 100_000, txCount: 5 });
    const after = snap({ total: 10_000, spendable: 10_000, txCount: 5 });
    expect(classifyBalanceChange(before, after).kind).toBe('funds-vanished');
  });

  it('treats history going backwards as vanishing too — the registry was wiped', () => {
    // ark-sdk.db being destroyed took the transaction history with it.
    const before = snap({ total: 34_882, spendable: 34_882, txCount: 12 });
    const after = snap({ total: 0, spendable: 0, txCount: 0 });
    expect(classifyBalanceChange(before, after).kind).toBe('funds-vanished');
  });

  it('uses a sane default threshold', () => {
    expect(DEFAULT_DROP_FRACTION).toBeGreaterThan(0);
    expect(DEFAULT_DROP_FRACTION).toBeLessThan(1);
  });
});

describe('classifyBalanceChange — recovery progress', () => {
  it('names the sweep: pendingRecovery falls, recoverable rises', () => {
    const before = snap({ total: 34_882, pendingRecovery: 34_882, txCount: 3 });
    const after = snap({ total: 34_882, recoverable: 34_882, txCount: 3 });
    const r = classifyBalanceChange(before, after);
    expect(r.kind).toBe('recovery-available');
    expect(r.severity).toBe('warn');
  });

  it('names completion: recoverable becomes spendable', () => {
    const before = snap({ total: 34_882, recoverable: 34_882, txCount: 3 });
    const after = snap({ total: 34_870, spendable: 34_870, txCount: 4 });
    const r = classifyBalanceChange(before, after);
    expect(r.kind).toBe('recovery-completed');
    expect(r.severity).toBe('info');
  });

  it('does not mistake recovery for vanishing — total held', () => {
    const before = snap({ total: 34_882, pendingRecovery: 34_882, txCount: 3 });
    const after = snap({ total: 34_882, recoverable: 34_882, txCount: 3 });
    expect(classifyBalanceChange(before, after).kind).not.toBe('funds-vanished');
  });

  it('flags funds becoming unspendable — a rotation stranding them again', () => {
    const before = snap({ total: 34_882, spendable: 34_882, txCount: 3 });
    const after = snap({ total: 34_882, pendingRecovery: 34_882, txCount: 3 });
    const r = classifyBalanceChange(before, after);
    expect(r.kind).toBe('funds-stranded');
    expect(r.severity).toBe('error');
  });
});

describe('classifyBalanceChange — quiet cases', () => {
  it('is steady when nothing moved', () => {
    const s = snap({ total: 34_882, pendingRecovery: 34_882, txCount: 3 });
    expect(classifyBalanceChange(s, s).kind).toBe('steady');
  });

  it('reports a receive rather than an alarm', () => {
    const before = snap({ total: 1_000, spendable: 1_000, txCount: 3 });
    const after = snap({ total: 5_000, spendable: 5_000, txCount: 4 });
    expect(classifyBalanceChange(before, after).kind).toBe('receive');
  });

  it('has no previous snapshot on first boot and stays quiet', () => {
    const r = classifyBalanceChange(null, snap({ total: 34_882, pendingRecovery: 34_882 }));
    expect(r.kind).toBe('first-observation');
    expect(r.severity).toBe('info');
  });

  it('a zero-balance wallet staying at zero is not an alarm', () => {
    const s = snap({ total: 0, txCount: 0 });
    expect(classifyBalanceChange(s, s).kind).toBe('steady');
  });
});

/**
 * The snapshot has to outlive the process, because the incident showed up *across a deploy*.
 * It lives in the wallet data dir, which has been on the Railway volume since `68ba6a8`.
 */
describe('balance snapshot persistence', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-balsnap-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null before anything has been written', () => {
    expect(readBalanceSnapshot(dir)).toBeNull();
  });

  it('round-trips a snapshot', () => {
    const s = snap({ total: 34_882, pendingRecovery: 34_882, txCount: 7 });
    writeBalanceSnapshot(dir, s);
    expect(readBalanceSnapshot(dir)).toMatchObject(s);
    expect(fs.existsSync(path.join(dir, BALANCE_SNAPSHOT_FILE))).toBe(true);
  });

  it('survives a corrupt file rather than throwing', () => {
    fs.writeFileSync(path.join(dir, BALANCE_SNAPSHOT_FILE), '{not json');
    expect(readBalanceSnapshot(dir)).toBeNull();
  });

  it('rejects a file missing required numeric fields', () => {
    fs.writeFileSync(path.join(dir, BALANCE_SNAPSHOT_FILE), JSON.stringify({ total: 'lots' }));
    expect(readBalanceSnapshot(dir)).toBeNull();
  });

  it('never throws when the directory is unwritable', () => {
    expect(() => writeBalanceSnapshot('/proc/nonexistent/nope', snap({ total: 1 }))).not.toThrow();
  });

  /**
   * `lastRecoveryAt` is what the Atlas watchdog reads to tell "recovery landed" from
   * "recovery still pending", and to escalate when it stays pending too long. It rides in the
   * same file as the balance snapshot so there is one durable artifact, not two.
   */
  it('has no recovery timestamp before one is recorded', () => {
    writeBalanceSnapshot(dir, snap({ total: 1 }));
    expect(readRecoveryState(dir).lastRecoveryAt).toBeNull();
  });

  it('records and reads back a recovery timestamp', () => {
    writeBalanceSnapshot(dir, snap({ total: 1 }));
    writeRecoveryState(dir, '2026-07-29T15:02:00.000Z');
    expect(readRecoveryState(dir).lastRecoveryAt).toBe('2026-07-29T15:02:00.000Z');
  });

  it('keeps the recovery timestamp when a later balance snapshot is written', () => {
    writeRecoveryState(dir, '2026-07-29T15:02:00.000Z');
    writeBalanceSnapshot(dir, snap({ total: 34_870, spendable: 34_870, txCount: 42 }));
    expect(readRecoveryState(dir).lastRecoveryAt).toBe('2026-07-29T15:02:00.000Z');
    expect(readBalanceSnapshot(dir)?.total).toBe(34_870);
  });

  it('returns null rather than throwing on a corrupt file', () => {
    fs.writeFileSync(path.join(dir, BALANCE_SNAPSHOT_FILE), '{broken');
    expect(readRecoveryState(dir).lastRecoveryAt).toBeNull();
  });

  it('detects the incident across a simulated restart', () => {
    writeBalanceSnapshot(dir, snap({ total: 34_882, spendable: 34_882, txCount: 12 }));
    const afterDeploy = snap({ total: 0, spendable: 0, txCount: 0 });
    const r = classifyBalanceChange(readBalanceSnapshot(dir), afterDeploy);
    expect(r.kind).toBe('funds-vanished');
    expect(r.severity).toBe('error');
  });
});
