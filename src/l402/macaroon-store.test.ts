/**
 * MacaroonStore tests — SQLite-backed time-based macaroon tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { MacaroonStore } from './macaroon-store.js';
import { mintTimedL402Macaroon, verifyL402Token, MemoryRootKeyStore } from './macaroon.js';

function makePreimage(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString('hex');
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex');
  return { preimage, paymentHash };
}

describe('MacaroonStore', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-macstore-'));
    dbPath = path.join(tmpDir, 'macaroons.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('register + verify returns valid with correct expiresAt', () => {
    const store = new MacaroonStore(dbPath);
    const { paymentHash } = makePreimage();
    const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now

    store.register(paymentHash, expiresAt, 500);
    const result = store.verify(paymentHash);

    expect(result.valid).toBe(true);
    expect(result.expiresAt).toBe(expiresAt);

    store.close();
  });

  it('expired macaroon returns valid: false', () => {
    const store = new MacaroonStore(dbPath);
    const { paymentHash } = makePreimage();
    const expiresAt = Math.floor(Date.now() / 1000) - 100; // Already expired

    store.register(paymentHash, expiresAt, 500);
    const result = store.verify(paymentHash);

    expect(result.valid).toBe(false);
    expect(result.expiresAt).toBe(expiresAt);

    store.close();
  });

  it('unknown payment_hash returns valid: false (anti-replay)', () => {
    const store = new MacaroonStore(dbPath);
    const result = store.verify('deadbeef'.repeat(8));

    expect(result.valid).toBe(false);
    expect(result.expiresAt).toBe(0);

    store.close();
  });

  it('cleanup removes expired macaroons older than 7 days', () => {
    const store = new MacaroonStore(dbPath);
    const { paymentHash: h1 } = makePreimage();
    const { paymentHash: h2 } = makePreimage();

    const now = Math.floor(Date.now() / 1000);

    // Expired 8 days ago — should be cleaned up
    store.register(h1, now - 8 * 86400, 500);
    // Expired 1 day ago — should NOT be cleaned up (< 7 days)
    store.register(h2, now - 86400, 500);

    const cleaned = store.cleanup();
    expect(cleaned).toBe(1);

    // h1 should be gone
    expect(store.get(h1)).toBeNull();
    // h2 should still be there
    expect(store.get(h2)).not.toBeNull();

    store.close();
  });

  it('cleanup preserves active (non-expired) macaroons', () => {
    const store = new MacaroonStore(dbPath);
    const { paymentHash } = makePreimage();
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;

    store.register(paymentHash, expiresAt, 500);
    const cleaned = store.cleanup();
    expect(cleaned).toBe(0);

    const result = store.verify(paymentHash);
    expect(result.valid).toBe(true);

    store.close();
  });

  it('activeCount returns correct count of non-expired entries', () => {
    const store = new MacaroonStore(dbPath);
    const now = Math.floor(Date.now() / 1000);

    const { paymentHash: h1 } = makePreimage();
    const { paymentHash: h2 } = makePreimage();
    const { paymentHash: h3 } = makePreimage();

    store.register(h1, now + 86400, 500);  // active
    store.register(h2, now + 3600, 500);   // active
    store.register(h3, now - 100, 500);    // expired

    expect(store.activeCount()).toBe(2);

    store.close();
  });

  it('database persists across MacaroonStore close/reopen', () => {
    const store1 = new MacaroonStore(dbPath);
    const { paymentHash } = makePreimage();
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;

    store1.register(paymentHash, expiresAt, 500);
    store1.close();

    const store2 = new MacaroonStore(dbPath);
    const result = store2.verify(paymentHash);

    expect(result.valid).toBe(true);
    expect(result.expiresAt).toBe(expiresAt);

    store2.close();
  });

  it('duplicate register is idempotent (INSERT OR IGNORE)', () => {
    const store = new MacaroonStore(dbPath);
    const { paymentHash } = makePreimage();
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;

    store.register(paymentHash, expiresAt, 500);
    store.register(paymentHash, expiresAt + 3600, 1000); // different values, same hash

    // Should keep original values (INSERT OR IGNORE)
    const record = store.get(paymentHash);
    expect(record?.expiresAt).toBe(expiresAt);
    expect(record?.priceSats).toBe(500);

    store.close();
  });

  it('verify updates last_verified_at', () => {
    const store = new MacaroonStore(dbPath);
    const { paymentHash } = makePreimage();
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;

    store.register(paymentHash, expiresAt, 500);

    // Before verify, last_verified_at is null
    const before = store.get(paymentHash);
    expect(before?.lastVerifiedAt).toBeNull();

    store.verify(paymentHash);

    const after = store.get(paymentHash);
    expect(after?.lastVerifiedAt).not.toBeNull();

    store.close();
  });
});

describe('Time-based macaroon minting', () => {
  it('mintTimedL402Macaroon adds expires_at caveat', () => {
    const rootKeyStore = new MemoryRootKeyStore();
    const { preimage, paymentHash } = makePreimage();

    const result = mintTimedL402Macaroon(rootKeyStore, {
      paymentHash,
      durationHours: 24,
    });

    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(result.macaroonBase64).toBeTruthy();

    // Verify the macaroon is valid
    const verifyResult = verifyL402Token(rootKeyStore, result.macaroonBase64, preimage);
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.expiresAt).toBe(result.expiresAt);
  });

  it('expires_at caveat cannot be tampered with (HMAC catches modification)', () => {
    const rootKeyStore = new MemoryRootKeyStore();
    const { preimage, paymentHash } = makePreimage();

    const result = mintTimedL402Macaroon(rootKeyStore, {
      paymentHash,
      durationHours: 24,
    });

    // Tamper with the macaroon bytes
    const binary = Buffer.from(result.macaroonBase64, 'base64');
    if (binary.length > 20) {
      binary[20] ^= 0xff;
    }
    const tampered = binary.toString('base64');

    const verifyResult = verifyL402Token(rootKeyStore, tampered, preimage);
    expect(verifyResult.valid).toBe(false);
  });

  it('expired timed macaroon returns valid: false', () => {
    vi.useFakeTimers();

    const rootKeyStore = new MemoryRootKeyStore();
    const { preimage, paymentHash } = makePreimage();

    const result = mintTimedL402Macaroon(rootKeyStore, {
      paymentHash,
      durationHours: 1, // 1 hour
    });

    // Fast-forward 2 hours
    vi.advanceTimersByTime(2 * 3600 * 1000);

    const verifyResult = verifyL402Token(rootKeyStore, result.macaroonBase64, preimage);
    expect(verifyResult.valid).toBe(false);
    expect(verifyResult.error).toContain('expired');

    vi.useRealTimers();
  });
});
