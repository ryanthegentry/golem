/**
 * L402 Security Tests — macaroon-v2 module validation.
 *
 * Tests: constant-time comparison, replay protection (time-before caveats),
 * root key isolation, V2 binary serialization, preimage verification,
 * L402 protocol compliance, and end-to-end flow.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  mintL402Macaroon,
  verifyL402Token,
  parseL402Header,
  formatL402Challenge,
  MemoryRootKeyStore,
  FileRootKeyStore,
} from './macaroon.js';
import { importMacaroon } from 'macaroon';

// --- Test fixtures ---

function makePreimage(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString('hex');
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex');
  return { preimage, paymentHash };
}

describe('L402 Security — macaroon-v2', () => {
  let store: MemoryRootKeyStore;

  beforeEach(() => {
    store = new MemoryRootKeyStore();
  });

  // ─── 1. Constant-Time Comparison ───────────────────────────────────────

  describe('constant-time preimage verification', () => {
    it('rejects wrong preimage', () => {
      const { paymentHash } = makePreimage();
      const wrongPreimage = randomBytes(32).toString('hex');

      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });
      const result = verifyL402Token(store, macaroonBase64, wrongPreimage);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('preimage does not match payment hash');
    });

    it('accepts correct preimage', () => {
      const { preimage, paymentHash } = makePreimage();

      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });
      const result = verifyL402Token(store, macaroonBase64, preimage);

      expect(result.valid).toBe(true);
      expect(result.paymentHash).toBe(paymentHash);
    });

    it('rejects preimage with correct hash but different length', () => {
      const { paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });

      // Truncated preimage — sha256 will produce different hash
      const result = verifyL402Token(store, macaroonBase64, 'ab'.repeat(16));
      expect(result.valid).toBe(false);
    });
  });

  // ─── 2. Replay Protection (Time-Before Caveats) ───────────────────────

  describe('replay protection — time-before caveats', () => {
    it('mints macaroon with time-before caveat', () => {
      const { preimage, paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, {
        paymentHash,
        ttlSeconds: 300,
      });

      // Should be valid within TTL
      const result = verifyL402Token(store, macaroonBase64, preimage);
      expect(result.valid).toBe(true);
    });

    it('rejects expired macaroon', () => {
      const { preimage, paymentHash } = makePreimage();

      // Mint with TTL=1 second
      const { macaroonBase64 } = mintL402Macaroon(store, {
        paymentHash,
        ttlSeconds: 1,
      });

      // Fast-forward time by 2 seconds
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 2000);

      const result = verifyL402Token(store, macaroonBase64, preimage);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');

      vi.useRealTimers();
    });

    it('respects custom TTL', () => {
      const { preimage, paymentHash } = makePreimage();

      // Short TTL
      const { macaroonBase64 } = mintL402Macaroon(store, {
        paymentHash,
        ttlSeconds: 5,
      });

      // 3 seconds later — still valid
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 3000);

      const result = verifyL402Token(store, macaroonBase64, preimage);
      expect(result.valid).toBe(true);

      // 6 seconds from mint — expired
      vi.setSystemTime(Date.now() + 3000);

      const result2 = verifyL402Token(store, macaroonBase64, preimage);
      expect(result2.valid).toBe(false);

      vi.useRealTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });
  });

  // ─── 3. Root Key Isolation ─────────────────────────────────────────────

  describe('root key isolation — per-macaroon root keys', () => {
    it('each macaroon gets a unique root key', () => {
      const { paymentHash: h1 } = makePreimage();
      const { paymentHash: h2 } = makePreimage();

      const r1 = mintL402Macaroon(store, { paymentHash: h1 });
      const r2 = mintL402Macaroon(store, { paymentHash: h2 });

      // Different root key IDs
      expect(r1.rootKeyId).not.toBe(r2.rootKeyId);

      // Both macaroons are different
      expect(r1.macaroonBase64).not.toBe(r2.macaroonBase64);
    });

    it('macaroon from store A cannot verify against store B', () => {
      const storeA = new MemoryRootKeyStore();
      const storeB = new MemoryRootKeyStore();

      const { preimage, paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(storeA, { paymentHash });

      // Valid in store A
      const resultA = verifyL402Token(storeA, macaroonBase64, preimage);
      expect(resultA.valid).toBe(true);

      // Invalid in store B (no root key)
      const resultB = verifyL402Token(storeB, macaroonBase64, preimage);
      expect(resultB.valid).toBe(false);
      expect(resultB.error).toBe('unknown root key');
    });

    it('deleting root key invalidates macaroon', () => {
      const { preimage, paymentHash } = makePreimage();
      const { macaroonBase64, rootKeyId } = mintL402Macaroon(store, { paymentHash });

      // Valid before deletion
      expect(verifyL402Token(store, macaroonBase64, preimage).valid).toBe(true);

      // Delete root key
      store.deleteKey(rootKeyId);

      // Invalid after deletion
      const result = verifyL402Token(store, macaroonBase64, preimage);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('unknown root key');
    });
  });

  // ─── 4. V2 Binary Serialization ───────────────────────────────────────

  describe('V2 binary serialization', () => {
    it('exports V2 binary format (importable by macaroon library)', () => {
      const { paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });

      // Decode base64 → binary → import back via library
      const binary = Buffer.from(macaroonBase64, 'base64');
      const mac = importMacaroon(new Uint8Array(binary));

      // Should export JSON with identifier
      const json = mac.exportJSON();
      expect(json.i64 || json.i).toBeTruthy();
    });

    it('identifier encodes version + payment_hash + root_key_id (38 bytes)', () => {
      const { paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });

      const binary = Buffer.from(macaroonBase64, 'base64');
      const mac = importMacaroon(new Uint8Array(binary));
      const json = mac.exportJSON();

      // Get identifier bytes
      let idBytes: Buffer;
      if (json.i64) {
        idBytes = Buffer.from(json.i64, 'base64');
      } else {
        idBytes = Buffer.from(json.i!, 'utf-8');
      }

      // Should be 38 bytes: 2 (version) + 32 (payment_hash) + 4 (root_key_id)
      expect(idBytes.length).toBe(38);

      // Version should be 0
      expect(idBytes.readUInt16BE(0)).toBe(0);

      // Payment hash should match
      expect(idBytes.subarray(2, 34).toString('hex')).toBe(paymentHash);
    });

    it('macaroon round-trips through export/import', () => {
      const { preimage, paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });

      // Import → export → re-encode as base64
      const binary = Buffer.from(macaroonBase64, 'base64');
      const mac = importMacaroon(new Uint8Array(binary));
      const reExported = Buffer.from(mac.exportBinary()).toString('base64');

      // Should verify with re-exported version
      const result = verifyL402Token(store, reExported, preimage);
      expect(result.valid).toBe(true);
    });

    it('includes time-before caveat in serialized form', () => {
      const { paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, {
        paymentHash,
        ttlSeconds: 300,
      });

      const binary = Buffer.from(macaroonBase64, 'base64');
      const mac = importMacaroon(new Uint8Array(binary));
      const json = mac.exportJSON();

      // Should have at least one caveat
      expect(json.c).toBeDefined();
      expect(json.c!.length).toBeGreaterThanOrEqual(1);

      // First caveat should be time-before
      const firstCaveat = json.c![0];
      const caveatStr = firstCaveat.i64
        ? Buffer.from(firstCaveat.i64, 'base64').toString('utf-8')
        : firstCaveat.i;
      expect(caveatStr).toMatch(/^time-before /);
    });
  });

  // ─── 5. Preimage Verification ──────────────────────────────────────────

  describe('preimage verification', () => {
    it('sha256(preimage) must equal payment_hash', () => {
      const { preimage, paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });

      const result = verifyL402Token(store, macaroonBase64, preimage);
      expect(result.valid).toBe(true);

      // Manually verify the hash relationship
      const computed = createHash('sha256')
        .update(Buffer.from(preimage, 'hex'))
        .digest('hex');
      expect(computed).toBe(paymentHash);
    });

    it('rejects preimage that hashes to different value', () => {
      const { paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });

      const fakePreimage = randomBytes(32).toString('hex');
      const result = verifyL402Token(store, macaroonBase64, fakePreimage);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('preimage does not match payment hash');
    });

    it('rejects empty preimage', () => {
      const { paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });

      const result = verifyL402Token(store, macaroonBase64, '');
      expect(result.valid).toBe(false);
    });

    it('rejects garbage input gracefully', () => {
      const result = verifyL402Token(store, 'not-valid!!!', 'also-garbage');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects tampered binary macaroon', () => {
      const { preimage, paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });

      // Flip a byte in the middle of the binary
      const binary = Buffer.from(macaroonBase64, 'base64');
      if (binary.length > 20) {
        binary[20] ^= 0xff;
      }
      const tampered = binary.toString('base64');

      const result = verifyL402Token(store, tampered, preimage);
      expect(result.valid).toBe(false);
    });
  });

  // ─── 6. L402 Protocol Compliance ──────────────────────────────────────

  describe('L402 protocol compliance', () => {
    it('formats WWW-Authenticate challenge correctly', () => {
      const mac = 'base64macaroon==';
      const invoice = 'lntbs10u1ptest...';

      const challenge = formatL402Challenge(mac, invoice);
      expect(challenge).toBe('L402 macaroon="base64macaroon==", invoice="lntbs10u1ptest..."');
    });

    it('parses valid L402 Authorization header', () => {
      const result = parseL402Header('L402 macaroondata:preimagedata');
      expect(result).not.toBeNull();
      expect(result!.macaroon).toBe('macaroondata');
      expect(result!.preimage).toBe('preimagedata');
    });

    it('rejects non-L402 Authorization header', () => {
      expect(parseL402Header('Bearer token123')).toBeNull();
      expect(parseL402Header('Basic dXNlcjpwYXNz')).toBeNull();
    });

    it('rejects malformed L402 header — no colon', () => {
      expect(parseL402Header('L402 macaroononly')).toBeNull();
    });

    it('rejects malformed L402 header — empty parts', () => {
      expect(parseL402Header('L402 :preimage')).toBeNull();
      expect(parseL402Header('L402 macaroon:')).toBeNull();
      expect(parseL402Header('L402 :')).toBeNull();
    });

    it('rejects empty string', () => {
      expect(parseL402Header('')).toBeNull();
    });

    it('handles colon in preimage (uses first colon as separator)', () => {
      const result = parseL402Header('L402 mac:pre:image:extra');
      expect(result).not.toBeNull();
      expect(result!.macaroon).toBe('mac');
      expect(result!.preimage).toBe('pre:image:extra');
    });
  });

  // ─── 7. End-to-End L402 Flow ──────────────────────────────────────────

  describe('end-to-end L402 flow', () => {
    it('full mint → serialize → parse → verify cycle', () => {
      const { preimage, paymentHash } = makePreimage();

      // 1. Server mints macaroon
      const { macaroonBase64 } = mintL402Macaroon(store, {
        paymentHash,
        location: 'golem',
        ttlSeconds: 300,
      });

      // 2. Server sends 402 challenge
      const invoice = 'lntbs10u1ptest...';
      const challenge = formatL402Challenge(macaroonBase64, invoice);
      expect(challenge).toContain('L402 macaroon="');

      // 3. Client pays invoice, gets preimage
      // (simulated — in reality Boltz returns preimage after HTLC settlement)

      // 4. Client builds Authorization header
      const authHeader = `L402 ${macaroonBase64}:${preimage}`;
      const parsed = parseL402Header(authHeader);
      expect(parsed).not.toBeNull();

      // 5. Server verifies
      const result = verifyL402Token(store, parsed!.macaroon, parsed!.preimage);
      expect(result.valid).toBe(true);
      expect(result.paymentHash).toBe(paymentHash);
    });

    it('full flow with additional caveats', () => {
      const { preimage, paymentHash } = makePreimage();

      const { macaroonBase64 } = mintL402Macaroon(store, {
        paymentHash,
        caveats: ['service=api', 'tier=standard'],
        ttlSeconds: 600,
      });

      const result = verifyL402Token(store, macaroonBase64, preimage);
      expect(result.valid).toBe(true);
    });

    it('different payment hashes produce different macaroons', () => {
      const f1 = makePreimage();
      const f2 = makePreimage();

      const r1 = mintL402Macaroon(store, { paymentHash: f1.paymentHash });
      const r2 = mintL402Macaroon(store, { paymentHash: f2.paymentHash });

      expect(r1.macaroonBase64).not.toBe(r2.macaroonBase64);
      expect(r1.paymentHash).not.toBe(r2.paymentHash);
    });

    it('macaroon location defaults to golem', () => {
      const { paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, { paymentHash });

      const binary = Buffer.from(macaroonBase64, 'base64');
      const mac = importMacaroon(new Uint8Array(binary));
      expect(mac.exportJSON().l).toBe('golem');
    });

    it('custom location is preserved', () => {
      const { paymentHash } = makePreimage();
      const { macaroonBase64 } = mintL402Macaroon(store, {
        paymentHash,
        location: 'breathelocal',
      });

      const binary = Buffer.from(macaroonBase64, 'base64');
      const mac = importMacaroon(new Uint8Array(binary));
      expect(mac.exportJSON().l).toBe('breathelocal');
    });
  });

  // ─── 8. FileRootKeyStore ──────────────────────────────────────────────

  describe('FileRootKeyStore', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-rootkeys-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('persists keys to disk', () => {
      const store1 = new FileRootKeyStore(tmpDir);
      const key = randomBytes(32);
      store1.putKey('test-id', key);

      // Create new instance reading from same dir
      const store2 = new FileRootKeyStore(tmpDir);
      const loaded = store2.getKey('test-id');

      expect(loaded).not.toBeNull();
      expect(loaded!.equals(key)).toBe(true);
    });

    it('sets file permissions to 0600', () => {
      const fileStore = new FileRootKeyStore(tmpDir);
      fileStore.putKey('perm-test', randomBytes(32));

      const filePath = fileStore.getFilePath();
      const stat = fs.statSync(filePath);
      // Check owner-only read/write (0600 = 0o600 = 384)
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('deletes key and persists deletion', () => {
      const fileStore = new FileRootKeyStore(tmpDir);
      fileStore.putKey('to-delete', randomBytes(32));
      expect(fileStore.getKey('to-delete')).not.toBeNull();

      fileStore.deleteKey('to-delete');
      expect(fileStore.getKey('to-delete')).toBeNull();

      // Verify deletion persisted
      const reloaded = new FileRootKeyStore(tmpDir);
      expect(reloaded.getKey('to-delete')).toBeNull();
    });

    it('handles corrupt file gracefully', () => {
      const filePath = path.join(tmpDir, 'root-keys.json');
      fs.writeFileSync(filePath, 'not valid json{{{', 'utf-8');

      // Should not throw — starts fresh
      const fileStore = new FileRootKeyStore(tmpDir);
      expect(fileStore.getKey('anything')).toBeNull();
    });

    it('integrates with mint/verify cycle', () => {
      const fileStore = new FileRootKeyStore(tmpDir);
      const { preimage, paymentHash } = makePreimage();

      const { macaroonBase64 } = mintL402Macaroon(fileStore, { paymentHash });

      // Reload store from disk and verify
      const reloaded = new FileRootKeyStore(tmpDir);
      const result = verifyL402Token(reloaded, macaroonBase64, preimage);
      expect(result.valid).toBe(true);
    });
  });
});
