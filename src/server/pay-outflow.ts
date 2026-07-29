/**
 * Persisted daily-outflow ledger for the Lightning payer route.
 *
 * The per-day cap only means anything if it survives a restart. An in-memory counter resets
 * on every Railway deploy, which quietly converts "10,000 sats per day" into "10,000 sats per
 * deploy" — and deploys are cheap for anyone holding a stolen API key. So the counter lives on
 * the same volume as the rest of the wallet state, keyed by UTC day.
 *
 * Small on purpose: two methods, one file, no locking. The server is a single process and the
 * route serialises its own reads and writes around each payment.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const OUTFLOW_FILE = 'pay-outflow.json';

export interface OutflowLedger {
  /** Sats already committed today (UTC). Zero on a new day, a fresh dir, or a corrupt file. */
  spentToday(): number;
  /** Add to today's total and persist. Throws if the write fails — the caller must not pay. */
  record(sats: number): void;
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
    } catch {
      return { day: utcDay(), spentSats: 0 }; // absent — first spend of the deployment
    }

    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.day !== 'string' ||
        typeof parsed?.spentSats !== 'number' ||
        !Number.isFinite(parsed.spentSats)
      ) {
        throw new Error('expected { day: string, spentSats: number }');
      }
      return { day: parsed.day, spentSats: parsed.spentSats };
    } catch (err) {
      // Loud, because it means today's cap just lost its memory.
      console.warn(
        `[pay-outflow] ${file} is unreadable (${err instanceof Error ? err.message : err}) — ` +
          'treating today as zero spent',
      );
      return { day: utcDay(), spentSats: 0 };
    }
  }

  return {
    spentToday(): number {
      const current = read();
      return current.day === utcDay() ? current.spentSats : 0;
    },

    record(sats: number): void {
      const today = utcDay();
      const current = read();
      const base = current.day === today ? current.spentSats : 0;
      const next: OutflowRecord = { day: today, spentSats: base + sats };

      // Write-then-rename: a reader never sees a truncated document, which would be
      // indistinguishable from "nothing spent today" and would hand back the whole cap.
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, file);
    },
  };
}
