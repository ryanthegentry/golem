/**
 * The daily-outflow ledger is the only thing standing between a compromised router token and
 * the whole hot wallet, so it has to survive the thing that actually happens in production:
 * a redeploy mid-day. An in-memory counter resets to zero on every restart, which turns a
 * daily cap into a per-deploy cap. Hence: persisted, UTC-dated, atomically written.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOutflowLedger, OUTFLOW_FILE } from './pay-outflow.js';

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

  it('warns and treats a corrupt file as empty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, OUTFLOW_FILE), 'not json at all');

    const ledger = createOutflowLedger(dir);
    expect(ledger.spentToday()).toBe(0);
    expect(warn).toHaveBeenCalled();

    ledger.record(25);
    expect(ledger.spentToday()).toBe(25);
  });

  it('warns and treats a structurally wrong file as empty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, OUTFLOW_FILE), JSON.stringify({ day: 7, spentSats: 'lots' }));

    expect(createOutflowLedger(dir).spentToday()).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('does not leave a temp file behind — writes are atomic', () => {
    createOutflowLedger(dir).record(10);
    expect(fs.readdirSync(dir)).toEqual([OUTFLOW_FILE]);
  });

  it('never leaves a partially written ledger visible under the real name', () => {
    // Rename is atomic; a reader either sees the old value or the new one, never a truncated
    // JSON document that would be indistinguishable from "nothing spent today".
    const ledger = createOutflowLedger(dir);
    ledger.record(1);
    for (let i = 0; i < 20; i++) {
      ledger.record(1);
      expect(() => readLedgerFile()).not.toThrow();
    }
    expect(ledger.spentToday()).toBe(21);
  });
});
