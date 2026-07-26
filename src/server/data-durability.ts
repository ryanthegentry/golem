/**
 * Boot invariant — will the wallet's data directory survive the next deploy?
 *
 * Getting this wrong is silent and expensive: the wallet starts, registers its default
 * contract, syncs, finds nothing, and reports a zero balance. Nothing errors. The coins are
 * still at the ASP under a contract script whose only record was the database that just got
 * thrown away, and the pre-signed unilateral-exit material went with it.
 *
 * Two independent signals, because neither is sufficient alone:
 *
 *   - The **mount table** answers "should it persist". A container's root is an `overlay`
 *     filesystem, replaced wholesale on every deploy; a Railway volume is a real block
 *     device. This is authoritative wherever /proc/mounts can be read.
 *   - A **marker file** answers "did it persist". Written every boot, read back on the next.
 *     It is the only signal available off Linux, and it is proof rather than inference — but
 *     it is weaker, because a restart without a redeploy keeps the overlay intact. So a
 *     surviving marker never overrides a proven-ephemeral mount.
 *
 * The check reports; it does not exit. A gateway that refuses to boot stops serving 402
 * challenges, which is worse than one that serves them while shouting about its storage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const MARKER_FILENAME = '.golem-durability.json';

const MOUNT_TABLE_PATH = '/proc/mounts';

/** Filesystems that do not survive a container replacement. */
const EPHEMERAL_FSTYPES = new Set(['overlay', 'overlayfs', 'aufs', 'tmpfs', 'ramfs']);

export type DurabilityConfidence = 'proven-ephemeral' | 'proven-persistent' | 'assumed';

export interface MountEntry {
  mountPoint: string;
  fsType: string;
}

export interface DurabilityReport {
  /** The directory as configured. */
  dataDir: string;
  /** The absolute path it resolves to. */
  resolvedPath: string;
  durable: boolean;
  confidence: DurabilityConfidence;
  reason: string;
  mountPoint: string | null;
  fsType: string | null;
  /** 1 on the first boot that ever wrote a marker here. */
  bootCount: number;
  previousBootAt: string | null;
  /** True when a marker written by an earlier boot was still here. */
  markerSurvived: boolean;
}

export interface DurabilityLogSink {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface DurabilityCheckOptions {
  /** Test seam. Returns the raw mount table, or null when it cannot be read. */
  readMountTable?: () => string | null;
  /** Test seam. Lets a test pin the absolute path without creating it. */
  resolvePath?: (dataDir: string) => string;
  now?: () => number;
}

/** `/proc/mounts` escapes space, tab, newline and backslash as three-digit octal. */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Rows are `device mountpoint fstype options dump pass`. Anything that does not look like a
 * mount is skipped — this runs at boot and must not throw on an unfamiliar table.
 */
export function parseMountTable(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const mountPoint = unescapeMountField(fields[1]);
    if (!mountPoint.startsWith('/')) continue;
    entries.push({ mountPoint, fsType: fields[2] });
  }
  return entries;
}

/**
 * The mount that governs a path: the longest mount point that contains it. Matching is on
 * whole path segments, so /app/data-l402x does not count as being under /app/data-l402.
 */
export function findMountFor(resolvedPath: string, mounts: MountEntry[]): MountEntry | null {
  let best: MountEntry | null = null;
  for (const entry of mounts) {
    const prefix = entry.mountPoint === '/' ? '/' : entry.mountPoint + '/';
    const contains = resolvedPath === entry.mountPoint || resolvedPath.startsWith(prefix);
    if (!contains) continue;
    if (!best || entry.mountPoint.length > best.mountPoint.length) best = entry;
  }
  return best;
}

function defaultReadMountTable(): string | null {
  try {
    return fs.readFileSync(MOUNT_TABLE_PATH, 'utf8');
  } catch {
    return null; // not Linux, or /proc is not mounted
  }
}

interface Marker {
  bootCount: number;
  lastBootAt: string;
}

function readMarker(dir: string): Marker | null {
  try {
    const raw = fs.readFileSync(path.join(dir, MARKER_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Marker>;
    if (typeof parsed.bootCount !== 'number' || !Number.isFinite(parsed.bootCount)) return null;
    return {
      bootCount: parsed.bootCount,
      lastBootAt: typeof parsed.lastBootAt === 'string' ? parsed.lastBootAt : '',
    };
  } catch {
    return null; // absent, unreadable, or corrupt — all mean "no prior boot recorded"
  }
}

export function checkDataDirDurability(
  dataDir: string,
  options: DurabilityCheckOptions = {},
): DurabilityReport {
  const now = options.now ?? Date.now;
  const resolvedPath = options.resolvePath ? options.resolvePath(dataDir) : path.resolve(dataDir);

  const base: DurabilityReport = {
    dataDir,
    resolvedPath,
    durable: false,
    confidence: 'assumed',
    reason: '',
    mountPoint: null,
    fsType: null,
    bootCount: 1,
    previousBootAt: null,
    markerSurvived: false,
  };

  // A directory that cannot be created or written stores nothing at all — a stronger
  // failure than an ephemeral one, and reported the same loud way.
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    return {
      ...base,
      confidence: 'proven-ephemeral',
      reason: `data dir is unwritable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const prior = readMarker(dataDir);
  const markerSurvived = prior !== null;
  const bootCount = (prior?.bootCount ?? 0) + 1;
  const previousBootAt = prior?.lastBootAt || null;

  try {
    fs.writeFileSync(
      path.join(dataDir, MARKER_FILENAME),
      JSON.stringify({ bootCount, lastBootAt: new Date(now()).toISOString() }, null, 2),
    );
  } catch (err) {
    return {
      ...base,
      markerSurvived,
      bootCount,
      previousBootAt,
      confidence: 'proven-ephemeral',
      reason: `data dir is unwritable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const table = (options.readMountTable ?? defaultReadMountTable)();
  const mount = table ? findMountFor(resolvedPath, parseMountTable(table)) : null;

  if (mount) {
    const ephemeral = EPHEMERAL_FSTYPES.has(mount.fsType);
    return {
      ...base,
      markerSurvived,
      bootCount,
      previousBootAt,
      mountPoint: mount.mountPoint,
      fsType: mount.fsType,
      durable: !ephemeral,
      confidence: ephemeral ? 'proven-ephemeral' : 'proven-persistent',
      reason: ephemeral
        ? `mount ${mount.mountPoint} uses the ${mount.fsType} filesystem — replaced on every deploy`
        : `mount ${mount.mountPoint} is ${mount.fsType}`,
    };
  }

  // No mount signal. The marker is all we have: if an earlier boot's marker came back, this
  // directory demonstrably survives a restart here.
  return {
    ...base,
    markerSurvived,
    bootCount,
    previousBootAt,
    durable: markerSurvived,
    confidence: 'assumed',
    reason: markerSurvived
      ? `no mount table; a marker from ${previousBootAt ?? 'an earlier boot'} survived`
      : 'no mount table and no marker from an earlier boot — durability unproven',
  };
}

/**
 * Boot-time reporting. Loud and repeated when the wallet's state is not going to survive,
 * one line when it is.
 */
export function formatDurabilityLog(
  report: DurabilityReport,
  sink: DurabilityLogSink = console,
): void {
  if (!report.durable && report.confidence !== 'assumed') {
    sink.error(
      `[durability] WALLET STATE IS NOT PERSISTENT — ${report.resolvedPath} (${report.reason})`,
    );
    sink.error(
      '[durability] ark-sdk.db lives here: the contract repository, the transaction history, ' +
        'and the pre-signed tx-tree data that unilateral exit needs.',
    );
    sink.error(
      '[durability] Consequence: the next deploy wipes it. Coins held under non-default ' +
        'contract scripts become invisible to this wallet — balance reads 0 with the funds ' +
        'still at the ASP — and unilateral exit is no longer possible.',
    );
    sink.error(
      '[durability] Fix: set GOLEM_WALLET_DATA_DIR to a path under a mounted volume ' +
        '(Railway: /app/data-l402/wallet). Continuing to serve — a wedged gateway is worse.',
    );
    return;
  }

  sink.log(
    `[durability] wallet data dir ${report.resolvedPath} durable=${report.durable} ` +
      `confidence=${report.confidence} mount=${report.mountPoint ?? 'unknown'} ` +
      `fstype=${report.fsType ?? 'unknown'} boot=${report.bootCount} ` +
      `marker_survived=${report.markerSurvived} prev_boot=${report.previousBootAt ?? 'none'}`,
  );
}
