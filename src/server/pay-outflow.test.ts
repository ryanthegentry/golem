/**
 * The daily-outflow ledger is the only thing standing between a compromised router token and
 * the whole hot wallet, so it has to survive the thing that actually happens in production:
 * a redeploy mid-day. An in-memory counter resets to zero on every restart, which turns a
 * daily cap into a per-deploy cap. Hence: persisted, UTC-dated, atomically written.
 *
 * Red-team 2026-07-29 (HIGH-004) established the other half: an unreadable ledger must STOP
 * spending, not permit it. A single corrupt byte previously handed back the entire daily cap,
 * and that was the only spend control in the codebase that failed open.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOutflowLedger, OutflowLedgerUnreadableError, OUTFLOW_FILE } from './pay-outflow.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-outflow-'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function readLedgerFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, OUTFLOW_FILE), 'utf8'));
}

describe('createOutflowLedger', () => {
  it('starts at zero in a fresh directory', () => {
    expect(createOutflowLedger(dir).spentToday()).toBe(0);
  });

  it('accumulates records within the day', () => {
    const ledger = createOutflowLedger(dir);
    ledger.record(100);
    ledger.record(50);
    expect(ledger.spentToday()).toBe(150);
  });

  it('persists across instances — a redeploy must not reset the cap', () => {
    createOutflowLedger(dir).record(700);
    expect(createOutflowLedger(dir).spentToday()).toBe(700);
  });

  it('writes { day, spentSats } with a UTC YYYY-MM-DD day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T23:45:00Z'));

    createOutflowLedger(dir).record(42);

    expect(readLedgerFile()).toMatchObject({ day: '2026-07-29', spentSats: 42 });
  });

  it('resets on UTC day rollover', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T23:45:00Z'));
    const ledger = createOutflowLedger(dir);
    ledger.record(9000);
    expect(ledger.spentToday()).toBe(9000);

    vi.setSystemTime(new Date('2026-07-30T00:15:00Z'));
    expect(ledger.spentToday()).toBe(0);

    ledger.record(100);
    expect(ledger.spentToday()).toBe(100);
    expect(readLedgerFile()).toMatchObject({ day: '2026-07-30', spentSats: 100 });
  });

  it('reads a stale day off disk as zero without rewriting it', () => {
    fs.writeFileSync(path.join(dir, OUTFLOW_FILE), JSON.stringify({ day: '2020-01-01', spentSats: 5000 }));
    expect(createOutflowLedger(dir).spentToday()).toBe(0);
  });

  it('does not leave a temp file behind — writes are atomic', () => {
    createOutflowLedger(dir).record(10);
    expect(fs.readdirSync(dir)).toEqual([OUTFLOW_FILE]);
  });
});

describe('createOutflowLedger — fail-closed on corruption (HIGH-004)', () => {
  it('throws a distinguishable error from spentToday when the file is corrupt', () => {
    fs.writeFileSync(path.join(dir, OUTFLOW_FILE), 'not json at all');
    const ledger = createOutflowLedger(dir);

    expect(() => ledger.spentToday()).toThrow(OutflowLedgerUnreadableError);
  });

  it('throws from spentToday when the file is structurally wrong', () => {
    fs.writeFileSync(path.join(dir, OUTFLOW_FILE), JSON.stringify({ day: 7, spentSats: 'lots' }));
    expect(() => createOutflowLedger(dir).spentToday()).toThrow(OutflowLedgerUnreadableError);
  });

  it('throws from record when the file is corrupt — never overwrites an unreadable ledger', () => {
    fs.writeFileSync(path.join(dir, OUTFLOW_FILE), '{"day":');
    const ledger = createOutflowLedger(dir);

    expect(() => ledger.record(10)).toThrow(OutflowLedgerUnreadableError);
    // The corrupt file is left exactly as found, for the operator to inspect.
    expect(fs.readFileSync(path.join(dir, OUTFLOW_FILE), 'utf8')).toBe('{"day":');
  });

  it('treats a MISSING file as zero, not as corruption', () => {
    // Absent is the ordinary first-boot state and must not disable spending.
    expect(() => createOutflowLedger(dir).spentToday()).not.toThrow();
    expect(createOutflowLedger(dir).spentToday()).toBe(0);
  });

  it('recovers once an operator repairs the file', () => {
    fs.writeFileSync(path.join(dir, OUTFLOW_FILE), 'garbage');
    const ledger = createOutflowLedger(dir);
    expect(() => ledger.spentToday()).toThrow(OutflowLedgerUnreadableError);

    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, OUTFLOW_FILE), JSON.stringify({ day: today, spentSats: 250 }));
    expect(ledger.spentToday()).toBe(250);
  });
});

describe('createOutflowLedger — release (reservation semantics)', () => {
  it('gives headroom back on a provably-clean failure', () => {
    const ledger = createOutflowLedger(dir);
    ledger.record(2000);
    ledger.release(2000);
    expect(ledger.spentToday()).toBe(0);
  });

  it('persists the release', () => {
    const ledger = createOutflowLedger(dir);
    ledger.record(2000);
    ledger.release(500);
    expect(createOutflowLedger(dir).spentToday()).toBe(1500);
  });

  it('never drives the counter negative', () => {
    const ledger = createOutflowLedger(dir);
    ledger.record(100);
    ledger.release(5000);
    expect(ledger.spentToday()).toBe(0);
  });

  it('does not resurrect yesterday — a release after rollover leaves today at zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T23:59:00Z'));
    const ledger = createOutflowLedger(dir);
    ledger.record(2000);

    vi.setSystemTime(new Date('2026-07-30T00:01:00Z'));
    ledger.release(2000);
    expect(ledger.spentToday()).toBe(0);
  });
});

/*
 * Note on fsync: the module fsyncs the temp file before the rename and the directory after,
 * per HIGH-004 item 2. That is not asserted here — `node:fs` is a frozen ESM namespace, so
 * `vi.spyOn(fs, 'fsyncSync')` throws "Cannot redefine property", and mocking the whole module
 * would take the real filesystem away from every other test in this file. The durability claim
 * rests on code review rather than on a test.
 */
describe('createOutflowLedger — durable writes (HIGH-004 items 2 and 3)', () => {
  it('does not use a fixed temp path that concurrent writers would collide on', () => {
    // A second process mid-write owns its own temp file. Ours must not be that path.
    const fixed = path.join(dir, `${OUTFLOW_FILE}.tmp`);
    fs.writeFileSync(fixed, 'other process, mid-write');

    createOutflowLedger(dir).record(10);

    expect(fs.readFileSync(fixed, 'utf8')).toBe('other process, mid-write');
    expect(readLedgerFile()).toMatchObject({ spentSats: 10 });
  });

  it('leaves no temp files of its own behind', () => {
    const ledger = createOutflowLedger(dir);
    ledger.record(10);
    ledger.release(5);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
