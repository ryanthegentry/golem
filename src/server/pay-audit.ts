/**
 * Per-payment audit trail for the Lightning payer route (red-team 2026-07-29, HIGH-005).
 *
 * The route's whole security story is "a stolen router token gets bounded losses". Bounded
 * losses nobody can see are still losses nobody can investigate: before this, an operator had
 * no record of which invoices were paid, when, or for how much, and the daily ledger held a
 * single integer with no per-payment detail.
 *
 * One JSONL line per attempt — including refusals, which are the interesting ones when a
 * credential is being probed. Deliberately append-only and deliberately dumb: no rotation, no
 * buffering, nothing that could lose the last line before a crash.
 *
 * NEVER records the preimage (it is the bearer credential the caller pays for) or the full
 * invoice. The payment hash identifies the attempt without being spendable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const PAY_AUDIT_FILE = 'pay-audit.jsonl';

export interface PayAuditEntry {
  ts: number;
  /** Hex payment hash — identifies the attempt without being a credential. */
  paymentHash: string;
  /** Invoice face value. */
  amountSats: number;
  /** What the wallet was actually asked to debit, once Boltz has quoted it. */
  expectedAmountSats?: number;
  outcome: 'paid' | 'rejected' | 'failed';
  code?: string;
}

export type PayAudit = (entry: PayAuditEntry) => void;

export function createPayAudit(dir: string): PayAudit {
  const file = path.join(dir, PAY_AUDIT_FILE);

  return (entry: PayAuditEntry): void => {
    // Field-by-field, never a spread of the caller's object: that is what guarantees a
    // preimage cannot reach the log by being added to the entry type later.
    const safe: PayAuditEntry = {
      ts: entry.ts,
      paymentHash: entry.paymentHash,
      amountSats: entry.amountSats,
      ...(entry.expectedAmountSats !== undefined ? { expectedAmountSats: entry.expectedAmountSats } : {}),
      outcome: entry.outcome,
      ...(entry.code ? { code: entry.code } : {}),
    };

    const debit = safe.expectedAmountSats !== undefined ? `${safe.expectedAmountSats}` : '-';
    console.log(
      `[pay-invoice] ${safe.outcome}${safe.code ? ` ${safe.code}` : ''} ` +
        `hash=${safe.paymentHash.slice(0, 12)} invoice=${safe.amountSats}sat debit=${debit}sat`,
    );

    try {
      fs.appendFileSync(file, `${JSON.stringify(safe)}\n`);
    } catch (err) {
      // A broken audit sink must not break settlement in progress — but say so loudly,
      // because from here on the trail has a hole in it.
      console.warn(`[pay-invoice] audit write failed: ${err instanceof Error ? err.message : err}`);
    }
  };
}
