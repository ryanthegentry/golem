/**
 * CovenantClaimsRepo tests — SQLite-backed persistence of prevTxBytes for keyless refresh.
 *
 * The repo records, for each covenant VTXO claimed by Golem's self-solver, the raw
 * unsigned Ark tx bytes that produced it. Refresh requires these bytes to populate
 * the PSBT `prevarktx` TLV unknown field so the Introspector can resolve
 * OP_INSPECTINPUTSCRIPTPUBKEY at sign time.
 *
 * Status transitions:
 *   claimed   → refreshed   (VTXO was consumed by a covenant refresh)
 *   claimed   → spent       (VTXO was consumed by collab-spend / unilateral exit)
 *   refreshed → spent       (the descendant was eventually spent too)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CovenantClaimsRepo } from './covenant-claims-repo.js';

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

function outpoint(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

describe('CovenantClaimsRepo', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-ccrepo-'));
    dbPath = path.join(tmpDir, 'covenant-claims.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recordClaim + getPrevTxBytes round-trips byte content', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const op = outpoint('aa'.repeat(32), 0);
    const prev = bytes(0x01, 0x02, 0x03, 0xff, 0xfe);

    repo.recordClaim(op, prev);
    const got = repo.getPrevTxBytes(op);

    expect(got).not.toBeNull();
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got!)).toEqual(Array.from(prev));

    repo.close();
  });

  it('getPrevTxBytes returns null for unknown outpoint', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const got = repo.getPrevTxBytes(outpoint('bb'.repeat(32), 7));
    expect(got).toBeNull();
    repo.close();
  });

  it('recordClaim is idempotent — duplicate outpoint preserves first write', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const op = outpoint('cc'.repeat(32), 0);
    const first = bytes(0xaa);
    const second = bytes(0xbb);

    repo.recordClaim(op, first, 1000);
    repo.recordClaim(op, second, 2000);

    const got = repo.get(op);
    expect(got).not.toBeNull();
    expect(Array.from(got!.prevTxBytes)).toEqual([0xaa]);
    expect(got!.claimedAt).toBe(1000);
    expect(got!.claimStatus).toBe('claimed');

    repo.close();
  });

  it('get returns the full record including status + timestamps', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const op = outpoint('dd'.repeat(32), 3);
    const prev = bytes(0xde, 0xad, 0xbe, 0xef);

    repo.recordClaim(op, prev, 12345);
    const rec = repo.get(op);

    expect(rec).not.toBeNull();
    expect(rec!.vtxoOutpoint).toBe(op);
    expect(Array.from(rec!.prevTxBytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(rec!.claimStatus).toBe('claimed');
    expect(rec!.claimedAt).toBe(12345);
    expect(rec!.refreshedAt).toBeNull();

    repo.close();
  });

  it('markRefreshed transitions status and records refreshedAt', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const op = outpoint('ee'.repeat(32), 0);

    repo.recordClaim(op, bytes(0x01), 1000);
    repo.markRefreshed(op, 2000);

    const rec = repo.get(op);
    expect(rec!.claimStatus).toBe('refreshed');
    expect(rec!.refreshedAt).toBe(2000);
    // prevTxBytes preserved across status transition
    expect(Array.from(rec!.prevTxBytes)).toEqual([0x01]);

    repo.close();
  });

  it('markSpent transitions status to spent', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const op = outpoint('ff'.repeat(32), 0);

    repo.recordClaim(op, bytes(0x02), 1000);
    repo.markSpent(op);

    const rec = repo.get(op);
    expect(rec!.claimStatus).toBe('spent');

    repo.close();
  });

  it('markRefreshed on unknown outpoint is a silent no-op (caller may not know history)', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    // Should not throw; should not create a row.
    repo.markRefreshed(outpoint('99'.repeat(32), 0), 1000);
    expect(repo.get(outpoint('99'.repeat(32), 0))).toBeNull();
    repo.close();
  });

  it('listByStatus filters correctly across mixed states', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const op1 = outpoint('11'.repeat(32), 0);
    const op2 = outpoint('22'.repeat(32), 0);
    const op3 = outpoint('33'.repeat(32), 0);

    repo.recordClaim(op1, bytes(0x01), 1000);
    repo.recordClaim(op2, bytes(0x02), 1500);
    repo.recordClaim(op3, bytes(0x03), 2000);
    repo.markRefreshed(op2, 2500);
    repo.markSpent(op3);

    const claimed = repo.listByStatus('claimed');
    const refreshed = repo.listByStatus('refreshed');
    const spent = repo.listByStatus('spent');

    expect(claimed.map(r => r.vtxoOutpoint)).toEqual([op1]);
    expect(refreshed.map(r => r.vtxoOutpoint)).toEqual([op2]);
    expect(spent.map(r => r.vtxoOutpoint)).toEqual([op3]);

    repo.close();
  });

  it('countByStatus matches listByStatus length', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    for (let i = 0; i < 5; i++) {
      repo.recordClaim(outpoint(`${i}${i}`.repeat(32), i), bytes(i), 1000 + i);
    }
    repo.markRefreshed(outpoint('11'.repeat(32), 1), 2000);
    repo.markRefreshed(outpoint('22'.repeat(32), 2), 2000);
    repo.markSpent(outpoint('33'.repeat(32), 3));

    expect(repo.countByStatus('claimed')).toBe(2);
    expect(repo.countByStatus('refreshed')).toBe(2);
    expect(repo.countByStatus('spent')).toBe(1);

    repo.close();
  });

  it('cleanup deletes spent entries older than threshold, preserves claimed/refreshed', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const opOld = outpoint('aa'.repeat(32), 0);
    const opNew = outpoint('bb'.repeat(32), 0);
    const opClaimed = outpoint('cc'.repeat(32), 0);

    const now = Date.now();
    const eightDaysAgo = now - 8 * 86_400_000;
    const oneDayAgo = now - 86_400_000;

    repo.recordClaim(opOld, bytes(0x01), eightDaysAgo);
    repo.markSpent(opOld);
    repo.recordClaim(opNew, bytes(0x02), oneDayAgo);
    repo.markSpent(opNew);
    repo.recordClaim(opClaimed, bytes(0x03), eightDaysAgo); // very old but still claimed

    const deleted = repo.cleanup(now - 7 * 86_400_000);
    expect(deleted).toBe(1);
    expect(repo.get(opOld)).toBeNull();
    expect(repo.get(opNew)).not.toBeNull();
    expect(repo.get(opClaimed)).not.toBeNull(); // not spent → preserved

    repo.close();
  });

  it('persists across close/reopen with bytes intact', () => {
    const op = outpoint('99'.repeat(32), 0);
    const prev = bytes(0xc0, 0xff, 0xee);

    const repo1 = new CovenantClaimsRepo(dbPath);
    repo1.recordClaim(op, prev, 4242);
    repo1.markRefreshed(op, 5555);
    repo1.close();

    const repo2 = new CovenantClaimsRepo(dbPath);
    const rec = repo2.get(op);
    expect(rec).not.toBeNull();
    expect(rec!.claimStatus).toBe('refreshed');
    expect(rec!.claimedAt).toBe(4242);
    expect(rec!.refreshedAt).toBe(5555);
    expect(Array.from(rec!.prevTxBytes)).toEqual([0xc0, 0xff, 0xee]);
    repo2.close();
  });

  it('handles empty BLOB defensively — recordClaim with empty bytes throws', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    expect(() =>
      repo.recordClaim(outpoint('aa'.repeat(32), 0), new Uint8Array(0)),
    ).toThrow(/prevTxBytes/i);
    repo.close();
  });

  it('preserves byte order for large blobs (1 KB)', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const op = outpoint('77'.repeat(32), 0);
    const big = new Uint8Array(1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 11) & 0xff;

    repo.recordClaim(op, big);
    const got = repo.getPrevTxBytes(op);

    expect(got).not.toBeNull();
    expect(got!.length).toBe(1024);
    for (let i = 0; i < big.length; i++) {
      expect(got![i]).toBe(big[i]);
    }

    repo.close();
  });

  it('rejects invalid status transitions out of `spent`', () => {
    const repo = new CovenantClaimsRepo(dbPath);
    const op = outpoint('66'.repeat(32), 0);

    repo.recordClaim(op, bytes(0x01));
    repo.markSpent(op);

    // Once spent, cannot regress.
    expect(() => repo.markRefreshed(op, Date.now())).toThrow(/spent/i);

    const rec = repo.get(op);
    expect(rec!.claimStatus).toBe('spent');

    repo.close();
  });
});
