/**
 * Per-payment audit trail (red-team 2026-07-29, HIGH-005).
 *
 * The route's entire security story is "a stolen router token gets bounded losses". Bounded
 * losses you cannot see are still losses you cannot investigate — before this, an operator had
 * no record of which invoices were paid, when, or for how much, and the daily ledger kept a
 * single integer with no per-payment detail.
 *
 * Hard constraint: never the preimage (it is the bearer credential) and never the full invoice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPayAudit, PAY_AUDIT_FILE } from './pay-audit.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pay-audit-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function readLines(): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(dir, PAY_AUDIT_FILE), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const HASH = 'a'.repeat(64);

describe('createPayAudit', () => {
  it('appends one JSON line per attempt', () => {
    const audit = createPayAudit(dir);
    audit({ ts: 1, paymentHash: HASH, amountSats: 1000, outcome: 'paid' });
    audit({ ts: 2, paymentHash: HASH, amountSats: 2000, outcome: 'rejected', code: 'PER_CALL_CAP' });

    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ts: 1, paymentHash: HASH, amountSats: 1000, outcome: 'paid' });
    expect(lines[1]).toMatchObject({ outcome: 'rejected', code: 'PER_CALL_CAP' });
  });

  it('records the actual debit alongside the invoice amount', () => {
    createPayAudit(dir)({ ts: 1, paymentHash: HASH, amountSats: 1000, expectedAmountSats: 1035, outcome: 'paid' });
    expect(readLines()[0]).toMatchObject({ amountSats: 1000, expectedAmountSats: 1035 });
  });

  it('persists across instances — the trail outlives a deploy', () => {
    createPayAudit(dir)({ ts: 1, paymentHash: HASH, amountSats: 1, outcome: 'paid' });
    createPayAudit(dir)({ ts: 2, paymentHash: HASH, amountSats: 2, outcome: 'paid' });
    expect(readLines()).toHaveLength(2);
  });

  it('writes only known fields — a preimage handed to it is dropped, not logged', () => {
    const audit = createPayAudit(dir);
    audit({
      ts: 1,
      paymentHash: HASH,
      amountSats: 1000,
      outcome: 'paid',
      preimage: 'ff'.repeat(32),
      invoice: 'lnbc10u1psecret',
    } as never);

    const raw = fs.readFileSync(path.join(dir, PAY_AUDIT_FILE), 'utf8');
    expect(raw).not.toContain('ff'.repeat(32));
    expect(raw).not.toContain('lnbc10u1psecret');
    expect(Object.keys(readLines()[0]).sort()).toEqual(['amountSats', 'outcome', 'paymentHash', 'ts']);
  });

  it('logs a one-line summary per attempt', () => {
    createPayAudit(dir)({ ts: 1, paymentHash: HASH, amountSats: 1000, outcome: 'paid' });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(String((console.log as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])).toContain('[pay-invoice]');
  });

  it('never logs the preimage in the console summary', () => {
    createPayAudit(dir)({ ts: 1, paymentHash: HASH, amountSats: 1000, outcome: 'paid', preimage: 'ff'.repeat(32) } as never);
    const line = String((console.log as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(line).not.toContain('ff'.repeat(32));
  });

  it('never throws when the directory is unwritable — auditing must not break settlement', () => {
    const audit = createPayAudit(path.join(dir, 'does', 'not', 'exist'));
    expect(() => audit({ ts: 1, paymentHash: HASH, amountSats: 1, outcome: 'paid' })).not.toThrow();
  });
});
