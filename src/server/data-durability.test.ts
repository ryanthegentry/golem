/**
 * Boot invariant: is the wallet's data directory actually going to survive a deploy?
 *
 * Two independent signals. The mount table answers "should it persist" — an `overlay`
 * fstype is the container's copy-on-write root and is destroyed on every deploy. A marker
 * file answers "did it persist" — it is written on every boot and read back on the next.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseMountTable,
  findMountFor,
  checkDataDirDurability,
  formatDurabilityLog,
  MARKER_FILENAME,
} from './data-durability.js';

/** The shape Railway actually presents, trimmed to the relevant rows. */
const RAILWAY_MOUNTS = [
  'overlay / overlay rw,relatime,lowerdir=/var/lib/docker/overlay2/l/X 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  '/dev/zd5472 /app/data-l402 ext4 rw,relatime 0 0',
  'tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0',
].join('\n');

describe('parseMountTable', () => {
  it('reads mount point and fstype from /proc/mounts rows', () => {
    const mounts = parseMountTable(RAILWAY_MOUNTS);
    expect(mounts).toContainEqual({ mountPoint: '/', fsType: 'overlay' });
    expect(mounts).toContainEqual({ mountPoint: '/app/data-l402', fsType: 'ext4' });
  });

  it('decodes octal escapes in mount points', () => {
    const mounts = parseMountTable('/dev/sda1 /mnt/my\\040volume ext4 rw 0 0');
    expect(mounts[0].mountPoint).toBe('/mnt/my volume');
  });

  it('skips blank and malformed lines instead of throwing', () => {
    const mounts = parseMountTable('\n\ngarbage\n/dev/sda1 /data ext4 rw 0 0\n');
    expect(mounts).toEqual([{ mountPoint: '/data', fsType: 'ext4' }]);
  });
});

describe('findMountFor', () => {
  const mounts = parseMountTable(RAILWAY_MOUNTS);

  it('picks the longest matching mount point, not the first', () => {
    expect(findMountFor('/app/data-l402/wallet', mounts)).toEqual({
      mountPoint: '/app/data-l402',
      fsType: 'ext4',
    });
  });

  it('falls back to / for a path on no dedicated mount', () => {
    expect(findMountFor('/app/data', mounts)).toEqual({ mountPoint: '/', fsType: 'overlay' });
  });

  it('matches on whole path segments — /app/data-l402x is not under /app/data-l402', () => {
    expect(findMountFor('/app/data-l402x/wallet', mounts)).toEqual({
      mountPoint: '/',
      fsType: 'overlay',
    });
  });

  it('matches the mount point itself, not only its children', () => {
    expect(findMountFor('/app/data-l402', mounts)).toEqual({
      mountPoint: '/app/data-l402',
      fsType: 'ext4',
    });
  });

  it('returns null when nothing matches', () => {
    expect(findMountFor('/app', [{ mountPoint: '/srv', fsType: 'ext4' }])).toBeNull();
  });
});

describe('checkDataDirDurability', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-durability-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports durable=false when the dir sits on the container overlay', () => {
    const report = checkDataDirDurability(tmpDir, {
      readMountTable: () => RAILWAY_MOUNTS,
      resolvePath: () => '/app/data',
    });

    expect(report.durable).toBe(false);
    expect(report.confidence).toBe('proven-ephemeral');
    expect(report.fsType).toBe('overlay');
    expect(report.mountPoint).toBe('/');
  });

  it('reports durable=true when the dir sits on the mounted volume', () => {
    const report = checkDataDirDurability(tmpDir, {
      readMountTable: () => RAILWAY_MOUNTS,
      resolvePath: () => '/app/data-l402/wallet',
    });

    expect(report.durable).toBe(true);
    expect(report.confidence).toBe('proven-persistent');
    expect(report.fsType).toBe('ext4');
    expect(report.mountPoint).toBe('/app/data-l402');
  });

  it('treats tmpfs as ephemeral too', () => {
    const report = checkDataDirDurability(tmpDir, {
      readMountTable: () => '/dev/x /data tmpfs rw 0 0',
      resolvePath: () => '/data/wallet',
    });
    expect(report.durable).toBe(false);
    expect(report.confidence).toBe('proven-ephemeral');
  });

  it('creates the directory when it does not exist yet', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'wallet');
    checkDataDirDurability(nested, { readMountTable: () => null });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('writes a marker on first boot and reports no prior boot', () => {
    const report = checkDataDirDurability(tmpDir, { readMountTable: () => null });

    expect(report.bootCount).toBe(1);
    expect(report.previousBootAt).toBeNull();
    expect(report.markerSurvived).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, MARKER_FILENAME))).toBe(true);
  });

  it('sees the marker survive across a restart and counts boots', () => {
    const first = checkDataDirDurability(tmpDir, {
      readMountTable: () => null,
      now: () => new Date('2026-07-25T10:00:00Z').getTime(),
    });
    const second = checkDataDirDurability(tmpDir, {
      readMountTable: () => null,
      now: () => new Date('2026-07-25T11:00:00Z').getTime(),
    });

    expect(first.markerSurvived).toBe(false);
    expect(second.markerSurvived).toBe(true);
    expect(second.bootCount).toBe(2);
    expect(second.previousBootAt).toBe('2026-07-25T10:00:00.000Z');
  });

  it('falls back to the marker when the mount table is unreadable', () => {
    // macOS and any non-Linux host: no /proc/mounts, so the mount signal cannot answer.
    const first = checkDataDirDurability(tmpDir, { readMountTable: () => null });
    expect(first.confidence).toBe('assumed');
    expect(first.durable).toBe(false); // nothing has been proven to survive yet

    const second = checkDataDirDurability(tmpDir, { readMountTable: () => null });
    expect(second.confidence).toBe('assumed');
    expect(second.durable).toBe(true); // the marker came back — data does survive here
  });

  it('a surviving marker does not override a proven-ephemeral mount', () => {
    // Railway restarts without a redeploy keep the overlay, so the marker can survive on a
    // filesystem that the next deploy still wipes. The mount table wins.
    const opts = {
      readMountTable: () => RAILWAY_MOUNTS,
      resolvePath: () => '/app/data',
    };
    checkDataDirDurability(tmpDir, opts);
    const second = checkDataDirDurability(tmpDir, opts);

    expect(second.markerSurvived).toBe(true);
    expect(second.durable).toBe(false);
    expect(second.confidence).toBe('proven-ephemeral');
  });

  it('survives a corrupt marker without throwing', () => {
    fs.writeFileSync(path.join(tmpDir, MARKER_FILENAME), '{not json');
    const report = checkDataDirDurability(tmpDir, { readMountTable: () => null });
    expect(report.bootCount).toBe(1);
    expect(report.markerSurvived).toBe(false);
  });

  it('never throws when the directory cannot be written', () => {
    const report = checkDataDirDurability('/proc/nonexistent/wallet', {
      readMountTable: () => null,
    });
    expect(report.durable).toBe(false);
    expect(report.reason).toMatch(/unwritable|ENOENT|EACCES|EROFS|ENOTDIR/i);
  });
});

describe('formatDurabilityLog', () => {
  const ephemeral = {
    dataDir: './data',
    resolvedPath: '/app/data',
    durable: false,
    confidence: 'proven-ephemeral' as const,
    reason: 'mount / is an overlay filesystem',
    mountPoint: '/',
    fsType: 'overlay',
    bootCount: 1,
    previousBootAt: null,
    markerSurvived: false,
  };

  it('logs at error level and names the consequence when not durable', () => {
    const sink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    formatDurabilityLog(ephemeral, sink);

    expect(sink.error).toHaveBeenCalled();
    const text = sink.error.mock.calls.flat().join(' ');
    expect(text).toContain('/app/data');
    expect(text).toMatch(/ark-sdk\.db/);
    expect(text).toMatch(/unilateral exit/i);
    expect(text).toMatch(/GOLEM_WALLET_DATA_DIR/);
    expect(sink.error.mock.calls.length).toBeGreaterThanOrEqual(2); // unmissable, not one line
  });

  it('logs a single quiet line when the dir is on a real volume', () => {
    const sink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    formatDurabilityLog({ ...ephemeral, durable: true, confidence: 'proven-persistent', fsType: 'ext4', mountPoint: '/app/data-l402' }, sink);

    expect(sink.error).not.toHaveBeenCalled();
    expect(sink.log).toHaveBeenCalledTimes(1);
    expect(sink.log.mock.calls.flat().join(' ')).toMatch(/durable=true/);
  });

  it('does not shout on a dev machine where the mount table cannot answer', () => {
    const sink = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    formatDurabilityLog({ ...ephemeral, confidence: 'assumed', fsType: null, mountPoint: null }, sink);

    expect(sink.error).not.toHaveBeenCalled();
  });
});
