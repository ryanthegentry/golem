/**
 * Watches what the balance is doing and names it.
 *
 * On 2026-07-25 the production wallet went 34,882 sats → 0 across a deploy and nothing
 * screamed; a human noticed a dashboard. The diagnostic that cracked the case is the one worth
 * automating: *a wallet funded twenty minutes earlier should still show the receive — spends
 * don't erase history.*
 *
 * So the invariant is not "the balance fell". Auto-sweep and ordinary sends do that on purpose.
 * It is **the balance fell while transaction history did not grow**, which separates spending
 * money from losing sight of it.
 *
 * The same classifier names recovery progress, so the deprecated-signer sweep is observable
 * rather than inferred: `pendingRecovery` falls → `recoverable` rises → `spendable` rises.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Fraction of total that must disappear before it counts as vanishing rather than noise. */
export const DEFAULT_DROP_FRACTION = 0.5;

/**
 * Lives beside `.golem-durability.json` in the wallet data dir, which has been on the Railway
 * volume since `68ba6a8`. It has to outlive the process: the 2026-07-25 disappearance showed
 * up *across a deploy*, so the comparison that catches it is startup-to-startup.
 */
export const BALANCE_SNAPSHOT_FILE = '.golem-balance.json';

export interface BalanceSnapshot {
  total: number;
  spendable: number;
  pendingRecovery: number;
  recoverable: number;
  /** Length of the wallet's transaction history. The load-bearing signal. */
  txCount: number;
}

export type BalanceChangeKind =
  | 'first-observation'
  | 'steady'
  | 'receive'
  | 'spend'
  /** Balance fell materially and history did not grow — money we can no longer see. */
  | 'funds-vanished'
  /** Spendable funds became unspendable without leaving — e.g. a signer rotation. */
  | 'funds-stranded'
  /** The server swept an expired batch; the funds are now redeemable. */
  | 'recovery-available'
  /** Recoverable funds came back as spendable. */
  | 'recovery-completed';

export interface BalanceChange {
  kind: BalanceChangeKind;
  severity: 'info' | 'warn' | 'error';
  droppedSats: number;
  message: string;
}

export interface ClassifyOptions {
  dropFraction?: number;
}

export function classifyBalanceChange(
  previous: BalanceSnapshot | null,
  current: BalanceSnapshot,
  options: ClassifyOptions = {},
): BalanceChange {
  if (!previous) {
    return {
      kind: 'first-observation',
      severity: 'info',
      droppedSats: 0,
      message: `balance baseline ${current.total} sats (spendable ${current.spendable})`,
    };
  }

  const dropFraction = options.dropFraction ?? DEFAULT_DROP_FRACTION;
  const dropped = previous.total - current.total;
  // History going backwards is itself evidence of loss — the 2026-07-25 wipe took the
  // transaction table with it — so "did not grow" covers shrinking too.
  const historyGrew = current.txCount > previous.txCount;

  if (dropped > 0 && dropped >= previous.total * dropFraction && !historyGrew) {
    return {
      kind: 'funds-vanished',
      severity: 'error',
      droppedSats: dropped,
      message:
        `balance fell ${previous.total} -> ${current.total} sats (${dropped} gone) with no new ` +
        `transaction history (${previous.txCount} -> ${current.txCount}). Spends leave history; ` +
        `this looks like the wallet losing sight of funds, not spending them.`,
    };
  }

  // Total held but spendable turned into pending-recovery: the funds are still ours and still
  // there, we just can't spend them. This is the shape of a signer rotation.
  if (current.pendingRecovery > previous.pendingRecovery && current.spendable < previous.spendable) {
    return {
      kind: 'funds-stranded',
      severity: 'error',
      droppedSats: previous.spendable - current.spendable,
      message:
        `${current.pendingRecovery} sats moved to pending-recovery (spendable ` +
        `${previous.spendable} -> ${current.spendable}). Funds are intact but not spendable — ` +
        `check for a server signer rotation and whether the SDK is current.`,
    };
  }

  if (current.recoverable > previous.recoverable && current.pendingRecovery < previous.pendingRecovery) {
    return {
      kind: 'recovery-available',
      severity: 'warn',
      droppedSats: 0,
      message:
        `${current.recoverable} sats became recoverable (pending-recovery ` +
        `${previous.pendingRecovery} -> ${current.pendingRecovery}). The server swept the batch; ` +
        `a recovery settle can now redeem them.`,
    };
  }

  if (current.spendable > previous.spendable && current.recoverable < previous.recoverable) {
    return {
      kind: 'recovery-completed',
      severity: 'info',
      droppedSats: 0,
      message:
        `recovery settled: ${current.spendable - previous.spendable} sats are spendable again ` +
        `(recoverable ${previous.recoverable} -> ${current.recoverable}).`,
    };
  }

  // A spend leaves history. A drop without history that is too small to look like loss is
  // noise — fee dust, rounding, a preconfirmed value settling — and gets no name of its own.
  if (dropped > 0 && historyGrew) {
    return {
      kind: 'spend',
      severity: 'info',
      droppedSats: dropped,
      message: `balance fell ${previous.total} -> ${current.total} sats with new history`,
    };
  }

  if (current.total > previous.total) {
    return {
      kind: 'receive',
      severity: 'info',
      droppedSats: 0,
      message: `balance rose ${previous.total} -> ${current.total} sats`,
    };
  }

  return { kind: 'steady', severity: 'info', droppedSats: 0, message: 'balance steady' };
}

const NUMERIC_FIELDS = ['total', 'spendable', 'pendingRecovery', 'recoverable', 'txCount'] as const;

/** Last observed balance, or null when absent, unreadable or malformed. */
export function readBalanceSnapshot(dir: string): BalanceSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, BALANCE_SNAPSHOT_FILE), 'utf8'));
    for (const f of NUMERIC_FIELDS) {
      if (typeof parsed?.[f] !== 'number' || !Number.isFinite(parsed[f])) return null;
    }
    return {
      total: parsed.total,
      spendable: parsed.spendable,
      pendingRecovery: parsed.pendingRecovery,
      recoverable: parsed.recoverable,
      txCount: parsed.txCount,
    };
  } catch {
    return null; // absent, unreadable or corrupt — all mean "no baseline"
  }
}

function readRaw(dir: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, BALANCE_SNAPSHOT_FILE), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Record the current balance. Never throws: failing to write a monitoring breadcrumb must not
 * take down a wallet that is otherwise working. Preserves `lastRecoveryAt`, which is written on
 * a different schedule and must not be clobbered by a routine balance observation.
 */
export function writeBalanceSnapshot(dir: string, snapshot: BalanceSnapshot): void {
  try {
    const existing = readRaw(dir);
    fs.writeFileSync(
      path.join(dir, BALANCE_SNAPSHOT_FILE),
      JSON.stringify(
        {
          ...snapshot,
          observedAt: new Date().toISOString(),
          ...(typeof existing.lastRecoveryAt === 'string'
            ? { lastRecoveryAt: existing.lastRecoveryAt }
            : {}),
        },
        null,
        2,
      ),
    );
  } catch {
    /* observability only */
  }
}

export interface RecoveryState {
  /** ISO timestamp of the last recovery settle that landed, or null. */
  lastRecoveryAt: string | null;
}

/**
 * When a recovery settle last landed. The Atlas watchdog reads this to tell "recovery landed"
 * from "recovery still pending", and to escalate when funds sit recoverable for too long.
 */
export function readRecoveryState(dir: string): RecoveryState {
  const raw = readRaw(dir);
  return {
    lastRecoveryAt: typeof raw.lastRecoveryAt === 'string' ? raw.lastRecoveryAt : null,
  };
}

/** Stamp a landed recovery, preserving whatever balance snapshot is already on disk. */
export function writeRecoveryState(dir: string, at: string): void {
  try {
    const existing = readRaw(dir);
    fs.writeFileSync(
      path.join(dir, BALANCE_SNAPSHOT_FILE),
      JSON.stringify({ ...existing, lastRecoveryAt: at }, null, 2),
    );
  } catch {
    /* observability only */
  }
}
