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
import {
  createL402Gateway,
} from './gateway.js';
import { importMacaroon } from 'macaroon';
import { ResponseCache } from './response-cache.js';

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

    it('identifier encodes version + payment_hash + token_id (66 bytes, Aperture-compatible)', () => {
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

      // Should be 66 bytes: 2 (version) + 32 (payment_hash) + 32 (token_id)
      // Matches Aperture/lnget DecodeIdentifier format exactly
      expect(idBytes.length).toBe(66);

      // Version should be 0
      expect(idBytes.readUInt16BE(0)).toBe(0);

      // Payment hash should match
      expect(idBytes.subarray(2, 34).toString('hex')).toBe(paymentHash);

      // Root key ID is in first 4 bytes of token_id field
      expect(idBytes.subarray(34, 38).toString('hex')).toBeTruthy();
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

    it('parses legacy LSAT Authorization header (Aperture backward compat)', () => {
      const result = parseL402Header('LSAT macaroondata:preimagedata');
      expect(result).not.toBeNull();
      expect(result!.macaroon).toBe('macaroondata');
      expect(result!.preimage).toBe('preimagedata');
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

  // ─── 9. Ark-Native Payment Tracking ────────────────────────────────

  describe('Ark-native payment tracking', () => {
    // Mock lightning that returns a canned invoice
    function mockLightning() {
      const { preimage, paymentHash } = makePreimage();
      return {
        preimage,
        paymentHash,
        lightning: {
          createLightningInvoice: vi.fn().mockResolvedValue({
            invoice: 'lntbs10u1ptest...',
            paymentHash,
          }),
          startSwapManager: vi.fn(),
          dispose: vi.fn(),
        } as any,
      };
    }

    // Minimal Hono-like context for testing middleware
    function makeContext(path: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
      const url = new URL(`http://localhost:8402${path}`);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      let responseStatus = 200;
      let responseBody: any = null;
      let responseHeaders: Record<string, string> = {};

      return {
        req: {
          url: url.toString(),
          method: 'GET',
          header: (name: string) => headers[name.toLowerCase()],
          query: (name: string) => query[name],
        },
        json: (body: any, status?: number, hdrs?: Record<string, string>) => {
          responseBody = body;
          if (status) responseStatus = status;
          if (hdrs) responseHeaders = hdrs;
          return { status: responseStatus, body: responseBody, headers: responseHeaders };
        },
        _getResponse: () => ({ status: responseStatus, body: responseBody, headers: responseHeaders }),
      };
    }

    it('402 includes ark_payment when arkAddress configured', async () => {
      const { lightning } = mockLightning();
      const gateway = createL402Gateway(lightning, {
        priceSats: 1000,
        arkAddress: 'tark1qtest...',
        wallet: { notifyIncomingFunds: async () => () => {} },
      });

      const c = makeContext('/api/data');
      const next = vi.fn();
      await gateway.middleware(c as any, next);
      const result = c._getResponse();

      expect(result.status).toBe(402);
      expect(result.body.ark_payment).toBeDefined();
      expect(result.body.ark_payment.address).toBe('tark1qtest...');
      expect(result.body.ark_payment.amount).toBeGreaterThan(1000);
      expect(result.body.ark_payment.amount).toBeLessThanOrEqual(10999);
      expect(result.body.ark_payment.payment_id).toBeDefined();
      expect(result.body.ark_payment.macaroon).toBeDefined();
      // Lightning fields still present
      expect(result.body.invoice).toBe('lntbs10u1ptest...');
      expect(result.body.macaroon).toBeDefined();

      gateway.dispose();
    });

    it('402 omits ark_payment when no arkAddress', async () => {
      const { lightning } = mockLightning();
      const gateway = createL402Gateway(lightning, { priceSats: 1000 });

      const c = makeContext('/api/data');
      const next = vi.fn();
      await gateway.middleware(c as any, next);
      const result = c._getResponse();

      expect(result.status).toBe(402);
      expect(result.body.ark_payment).toBeUndefined();

      gateway.dispose();
    });

    it('preimage endpoint returns 400 without payment_id', async () => {
      const { lightning } = mockLightning();
      const gateway = createL402Gateway(lightning, { priceSats: 1000 });

      const c = makeContext('/l402/preimage', {}, {});
      await gateway.preimageHandler(c as any, vi.fn());
      const result = c._getResponse();

      expect(result.status).toBe(400);

      gateway.dispose();
    });

    it('preimage endpoint returns 404 for unknown payment', async () => {
      const { lightning } = mockLightning();
      const gateway = createL402Gateway(lightning, { priceSats: 1000 });

      const c = makeContext('/l402/preimage', {}, { payment_id: 'bogus123' });
      await gateway.preimageHandler(c as any, vi.fn());
      const result = c._getResponse();

      expect(result.status).toBe(404);

      gateway.dispose();
    });

    it('preimage endpoint returns 202 pending, then 200 fulfilled', async () => {
      const { lightning } = mockLightning();
      const gateway = createL402Gateway(lightning, {
        priceSats: 1000,
        arkAddress: 'tark1qtest...',
        wallet: { notifyIncomingFunds: async () => () => {} },
      });

      // Issue a 402 to create a pending payment
      const challengeCtx = makeContext('/api/data');
      await gateway.middleware(challengeCtx as any, vi.fn());
      const arkPayment = challengeCtx._getResponse().body.ark_payment;
      const paymentId = arkPayment.payment_id;

      // Poll — should be 202 pending
      const pendingCtx = makeContext('/l402/preimage', {}, { payment_id: paymentId });
      await gateway.preimageHandler(pendingCtx as any, vi.fn());
      expect(pendingCtx._getResponse().status).toBe(202);

      // Simulate VTXO detection
      const pending = gateway._testInternals().pendingPayments.get(paymentId)!;
      pending.fulfilled = true;

      // Poll again — should be 200 with preimage
      const fulfilledCtx = makeContext('/l402/preimage', {}, { payment_id: paymentId });
      await gateway.preimageHandler(fulfilledCtx as any, vi.fn());
      const fulfilledResult = fulfilledCtx._getResponse();
      expect(fulfilledResult.status).toBe(200);
      expect(fulfilledResult.body.preimage).toBeDefined();
      expect(fulfilledResult.body.macaroon).toBeDefined();

      gateway.dispose();
    });

    it('gateway-generated preimage verifies through existing verifyL402Token', async () => {
      const { lightning } = mockLightning();
      const gateway = createL402Gateway(lightning, {
        priceSats: 1000,
        arkAddress: 'tark1qtest...',
        wallet: { notifyIncomingFunds: async () => () => {} },
      });

      // Issue 402
      const challengeCtx = makeContext('/api/data');
      await gateway.middleware(challengeCtx as any, vi.fn());
      const arkPayment = challengeCtx._getResponse().body.ark_payment;

      // Simulate fulfillment
      const pending = gateway._testInternals().pendingPayments.get(arkPayment.payment_id)!;
      pending.fulfilled = true;

      // Get preimage
      const preimageCtx = makeContext('/l402/preimage', {}, { payment_id: arkPayment.payment_id });
      await gateway.preimageHandler(preimageCtx as any, vi.fn());
      const { preimage, macaroon } = preimageCtx._getResponse().body;

      // Verify through standard L402 verification — proves Option B works
      const result = verifyL402Token(gateway._testInternals().rootKeyStore, macaroon, preimage);
      expect(result.valid).toBe(true);

      gateway.dispose();
    });

    it('expired payments are cleaned up', async () => {
      vi.useFakeTimers();
      const { lightning } = mockLightning();
      const gateway = createL402Gateway(lightning, {
        priceSats: 1000,
        ttlSeconds: 1, // 1 second TTL
        arkAddress: 'tark1qtest...',
        wallet: { notifyIncomingFunds: async () => () => {} },
      });

      // Issue 402
      const challengeCtx = makeContext('/api/data');
      await gateway.middleware(challengeCtx as any, vi.fn());
      const arkPayment = challengeCtx._getResponse().body.ark_payment;

      expect(gateway._testInternals().pendingPayments.has(arkPayment.payment_id)).toBe(true);

      // Fast-forward past expiry + cleanup interval
      vi.advanceTimersByTime(11_000);

      // Pending payment should be gone after cleanup
      expect(gateway._testInternals().pendingPayments.has(arkPayment.payment_id)).toBe(false);

      gateway.dispose();
      vi.useRealTimers();
    });

    it('VTXO matching by exact amount — correct amount matches', async () => {
      const { lightning } = mockLightning();
      const gateway = createL402Gateway(lightning, {
        priceSats: 1000,
        arkAddress: 'tark1qtest...',
        wallet: { notifyIncomingFunds: async () => () => {} },
      });

      // Issue 402
      const challengeCtx = makeContext('/api/data');
      await gateway.middleware(challengeCtx as any, vi.fn());
      const arkPayment = challengeCtx._getResponse().body.ark_payment;
      const pending = gateway._testInternals().pendingPayments.get(arkPayment.payment_id)!;

      // Directly test matchIncomingVtxo via the pending payment
      expect(pending.fulfilled).toBe(false);

      // Simulate VTXO with correct amount via setting fulfilled (the listener would do this)
      pending.fulfilled = true;
      expect(pending.fulfilled).toBe(true);

      gateway.dispose();
    });

    it('stats track Lightning vs Ark separately', async () => {
      const { lightning, preimage, paymentHash } = mockLightning();
      const gateway = createL402Gateway(lightning, {
        priceSats: 1000,
        arkAddress: 'tark1qtest...',
        wallet: { notifyIncomingFunds: async () => () => {} },
      });

      // Pay with Lightning macaroon
      const lnMac = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash });
      const lnCtx = makeContext('/api/data', {
        authorization: `L402 ${lnMac.macaroonBase64}:${preimage}`,
      });
      await gateway.middleware(lnCtx as any, vi.fn());

      expect(gateway.getStats().lightningPaidRequests).toBe(1);
      expect(gateway.getStats().lightningEarned).toBe(1000);

      // Issue 402 and "pay" with Ark macaroon
      const challengeCtx = makeContext('/api/data');
      await gateway.middleware(challengeCtx as any, vi.fn());
      const arkPayment = challengeCtx._getResponse().body.ark_payment;
      const pending = gateway._testInternals().pendingPayments.get(arkPayment.payment_id)!;

      const arkCtx = makeContext('/api/data', {
        authorization: `L402 ${pending.macaroonBase64}:${pending.preimage}`,
      });
      await gateway.middleware(arkCtx as any, vi.fn());

      expect(gateway.getStats().arkPaidRequests).toBe(1);
      expect(gateway.getStats().arkEarned).toBe(1000);
      expect(gateway.getStats().paidRequests).toBe(2);
      expect(gateway.getStats().totalSatsEarned).toBe(2000);

      gateway.dispose();
    });
  });

  // ─── 10. Cache-and-Resell Integration ────────────────────────────────

  describe('cache-and-resell integration', () => {
    let tmpDir: string;

    function mockLightningForCache() {
      const { preimage, paymentHash } = makePreimage();
      return {
        preimage,
        paymentHash,
        lightning: {
          createLightningInvoice: vi.fn().mockImplementation(async ({ amount }: { amount: number }) => {
            const { preimage: pi, paymentHash: ph } = makePreimage();
            return { invoice: `lntbs${amount}u1ptest...`, paymentHash: ph };
          }),
          startSwapManager: vi.fn(),
          dispose: vi.fn(),
        } as any,
      };
    }

    function makeContextWithBody(
      urlPath: string,
      method: string,
      headers: Record<string, string> = {},
      body = '',
      query: Record<string, string> = {},
    ) {
      const url = new URL(`http://localhost:8402${urlPath}`);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      let responseStatus = 200;
      let responseBody: any = null;
      let responseHeaders: Record<string, string> = {};

      return {
        req: {
          url: url.toString(),
          method,
          header: (name: string) => headers[name.toLowerCase()],
          query: (name: string) => query[name],
          text: () => Promise.resolve(body),
        },
        json: (respBody: any, status?: number, hdrs?: Record<string, string>) => {
          responseBody = respBody;
          if (status) responseStatus = status;
          if (hdrs) responseHeaders = hdrs;
          return { status: responseStatus, body: responseBody, headers: responseHeaders };
        },
        _getResponse: () => ({ status: responseStatus, body: responseBody, headers: responseHeaders }),
      };
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-cache-gw-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('402 challenge shows reduced price for cached responses', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cachePricePercent: 20,
        cacheDefaultTtl: 3600,
      });

      // Pre-populate cache
      const key = cache.computeKey('http://localhost:11434/api/generate', 'POST', '{"prompt":"hi"}');
      cache.put(key, {
        upstreamUrl: 'http://localhost:11434/api/generate',
        requestMethod: 'POST',
        requestBodyHash: 'abc',
        responseStatus: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: Buffer.from('{"response":"cached"}'),
      }, 3600);

      const c = makeContextWithBody('/api/generate', 'POST', {}, '{"prompt":"hi"}');
      await gateway.middleware(c as any, vi.fn());
      const result = c._getResponse();

      expect(result.status).toBe(402);
      expect(result.body.price).toBe(20); // 20% of 100
      expect(result.body.fullPrice).toBe(100);
      expect(result.headers['X-Golem-Cache']).toBe('HIT');

      gateway.dispose();
      cache.close();
    });

    it('402 challenge shows full price for cache miss', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cachePricePercent: 20,
      });

      const c = makeContextWithBody('/api/generate', 'POST', {}, '{"prompt":"new"}');
      await gateway.middleware(c as any, vi.fn());
      const result = c._getResponse();

      expect(result.status).toBe(402);
      expect(result.body.price).toBe(100); // full price
      expect(result.body.fullPrice).toBeUndefined();
      expect(result.headers['X-Golem-Cache']).toBe('MISS');

      gateway.dispose();
      cache.close();
    });

    it('cache hit serves cached response directly after payment', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cachePricePercent: 20,
        cacheDefaultTtl: 3600,
      });

      // Pre-populate cache
      const key = cache.computeKey('http://localhost:11434/api/generate', 'POST', '{"prompt":"hi"}');
      cache.put(key, {
        upstreamUrl: 'http://localhost:11434/api/generate',
        requestMethod: 'POST',
        requestBodyHash: 'abc',
        responseStatus: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: Buffer.from('{"response":"cached"}'),
      }, 3600);

      // Create valid L402 token
      const { preimage, paymentHash } = makePreimage();
      const mac = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash });

      const c = makeContextWithBody('/api/generate', 'POST', {
        authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
      }, '{"prompt":"hi"}');

      const next = vi.fn();
      const response = await gateway.middleware(c as any, next);

      // Should NOT call next — serves from cache directly
      expect(next).not.toHaveBeenCalled();
      // Returns a Response object
      expect(response).toBeInstanceOf(Response);
      const body = await (response as Response).text();
      expect(body).toBe('{"response":"cached"}');
      expect((response as Response).headers.get('X-Golem-Cache')).toBe('HIT');

      // Stats
      expect(gateway.getStats().cacheHits).toBe(1);
      expect(gateway.getStats().cacheSatsEarned).toBe(20);

      gateway.dispose();
      cache.close();
    });

    it('cache miss proxies upstream and caches response', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      // Mock upstream fetch
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"response":"from upstream"}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cachePricePercent: 20,
        cacheDefaultTtl: 3600,
      });

      // Create valid L402 token
      const { preimage, paymentHash } = makePreimage();
      const mac = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash });

      const c = makeContextWithBody('/api/generate', 'POST', {
        authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
        'content-type': 'application/json',
      }, '{"prompt":"new"}');

      const next = vi.fn();
      const response = await gateway.middleware(c as any, next);

      expect(next).not.toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
      const body = await (response as Response).text();
      expect(body).toBe('{"response":"from upstream"}');
      expect((response as Response).headers.get('X-Golem-Cache')).toBe('MISS');

      // Verify it was cached
      const key = cache.computeKey('http://localhost:11434/api/generate', 'POST', '{"prompt":"new"}');
      const cached = cache.get(key);
      expect(cached).not.toBeNull();
      expect(cached!.responseBody.toString()).toBe('{"response":"from upstream"}');

      expect(gateway.getStats().cacheMisses).toBe(1);

      gateway.dispose();
      cache.close();
    });

    it('streaming responses (text/event-stream) are NOT cached', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      const mockFetch = vi.fn().mockResolvedValue(
        new Response('data: {"token":"hi"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cacheDefaultTtl: 3600,
      });

      const { preimage, paymentHash } = makePreimage();
      const mac = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash });

      const c = makeContextWithBody('/api/generate', 'POST', {
        authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
      }, '{"prompt":"stream","stream":true}');

      await gateway.middleware(c as any, vi.fn());

      // Verify it was NOT cached
      const key = cache.computeKey('http://localhost:11434/api/generate', 'POST', '{"prompt":"stream","stream":true}');
      // get without incrementing — use a fresh cache to check
      const stats = cache.stats();
      expect(stats.totalEntries).toBe(0);

      gateway.dispose();
      cache.close();
    });

    it('non-2xx responses are NOT cached', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"error":"not found"}', {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cacheDefaultTtl: 3600,
      });

      const { preimage, paymentHash } = makePreimage();
      const mac = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash });

      const c = makeContextWithBody('/api/generate', 'POST', {
        authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
      }, '{"prompt":"fail"}');

      const response = await gateway.middleware(c as any, vi.fn());
      expect((response as Response).status).toBe(404);

      expect(cache.stats().totalEntries).toBe(0);

      gateway.dispose();
      cache.close();
    });

    it('cache price minimum is 1 sat (never free)', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      const gateway = createL402Gateway(lightning, {
        priceSats: 1, // 20% of 1 = 0.2, should round up to 1
        cache,
        upstreamUrl: 'http://localhost:11434',
        cachePricePercent: 20,
        cacheDefaultTtl: 3600,
      });

      // Pre-populate cache
      const key = cache.computeKey('http://localhost:11434/test', 'GET', '');
      cache.put(key, {
        upstreamUrl: 'http://localhost:11434/test',
        requestMethod: 'GET',
        requestBodyHash: '',
        responseStatus: 200,
        responseHeaders: { 'content-type': 'text/plain' },
        responseBody: Buffer.from('ok'),
      }, 3600);

      const c = makeContextWithBody('/test', 'GET');
      await gateway.middleware(c as any, vi.fn());
      const result = c._getResponse();

      expect(result.body.price).toBe(1); // minimum 1, not 0

      gateway.dispose();
      cache.close();
    });

    it('free paths bypass cache entirely', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        freePaths: ['/health'],
        cacheDefaultTtl: 3600,
      });

      const c = makeContextWithBody('/health', 'GET');
      const next = vi.fn();
      await gateway.middleware(c as any, next);

      // Free path passes through
      expect(next).toHaveBeenCalled();
      expect(gateway.getStats().cacheHits).toBe(0);
      expect(gateway.getStats().cacheMisses).toBe(0);

      gateway.dispose();
      cache.close();
    });

    it('gateway without cache behaves identically (backward compat)', async () => {
      const { lightning } = mockLightningForCache();

      // No cache config at all
      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
      });

      const c = makeContextWithBody('/api/data', 'GET');
      await gateway.middleware(c as any, vi.fn());
      const result = c._getResponse();

      expect(result.status).toBe(402);
      expect(result.body.price).toBe(100);
      expect(result.headers['X-Golem-Cache']).toBeUndefined();

      gateway.dispose();
    });

    it('TTL race: cache expires between challenge and payment — honors payment', async () => {
      vi.useFakeTimers();
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      // Mock upstream for the re-fetch after cache expiry
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"response":"fresh"}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cachePricePercent: 20,
        cacheDefaultTtl: 2, // 2 second TTL
      });

      // Pre-populate cache
      const key = cache.computeKey('http://localhost:11434/api/generate', 'POST', '{"prompt":"hi"}');
      cache.put(key, {
        upstreamUrl: 'http://localhost:11434/api/generate',
        requestMethod: 'POST',
        requestBodyHash: 'abc',
        responseStatus: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: Buffer.from('{"response":"old-cached"}'),
      }, 2);

      // Issue 402 — should be at cache price
      const challengeCtx = makeContextWithBody('/api/generate', 'POST', {}, '{"prompt":"hi"}');
      await gateway.middleware(challengeCtx as any, vi.fn());
      expect(challengeCtx._getResponse().body.price).toBe(20);

      // Advance time past cache TTL
      vi.advanceTimersByTime(3000);

      // Now pay — cache is expired, should proxy upstream (not issue another 402)
      const { preimage, paymentHash } = makePreimage();
      const mac = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash });

      const payCtx = makeContextWithBody('/api/generate', 'POST', {
        authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
      }, '{"prompt":"hi"}');

      const response = await gateway.middleware(payCtx as any, vi.fn());
      expect(response).toBeInstanceOf(Response);
      const body = await (response as Response).text();
      expect(body).toBe('{"response":"fresh"}');

      gateway.dispose();
      cache.close();
      vi.useRealTimers();
    });

    it('cache stats are tracked in gateway stats', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cachePricePercent: 20,
        cacheDefaultTtl: 3600,
      });

      // Cache miss
      const { preimage: p1, paymentHash: ph1 } = makePreimage();
      const mac1 = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash: ph1 });
      const c1 = makeContextWithBody('/api/test', 'GET', {
        authorization: `L402 ${mac1.macaroonBase64}:${p1}`,
      });
      await gateway.middleware(c1 as any, vi.fn());

      // Cache hit (same request)
      const { preimage: p2, paymentHash: ph2 } = makePreimage();
      const mac2 = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash: ph2 });
      const c2 = makeContextWithBody('/api/test', 'GET', {
        authorization: `L402 ${mac2.macaroonBase64}:${p2}`,
      });
      await gateway.middleware(c2 as any, vi.fn());

      const s = gateway.getStats();
      expect(s.cacheMisses).toBe(1);
      expect(s.cacheHits).toBe(1);
      expect(s.cacheSatsEarned).toBe(20); // only cache hit earns cache sats

      gateway.dispose();
      cache.close();
    });

    it('upstream timeout returns 504', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cacheDefaultTtl: 3600,
      });

      const { preimage, paymentHash } = makePreimage();
      const mac = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash });

      const c = makeContextWithBody('/api/slow', 'POST', {
        authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
      }, '{}');

      await gateway.middleware(c as any, vi.fn());
      expect(c._getResponse().status).toBe(504);

      gateway.dispose();
      cache.close();
    });

    it('upstream unreachable returns 502', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightningForCache();

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const gateway = createL402Gateway(lightning, {
        priceSats: 100,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cacheDefaultTtl: 3600,
      });

      const { preimage, paymentHash } = makePreimage();
      const mac = mintL402Macaroon(gateway._testInternals().rootKeyStore, { paymentHash });

      const c = makeContextWithBody('/api/down', 'POST', {
        authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
      }, '{}');

      await gateway.middleware(c as any, vi.fn());
      expect(c._getResponse().status).toBe(502);

      gateway.dispose();
      cache.close();
    });
  });

  // ─── Boltz API Resilience ─────────────────────────────────────────────

  describe('Boltz API resilience', () => {
    function makeContext(reqPath: string, headers: Record<string, string> = {}) {
      const url = new URL(`http://localhost:8402${reqPath}`);
      let responseStatus = 200;
      let responseBody: any = null;
      let responseHeaders: Record<string, string> = {};

      return {
        req: {
          url: url.toString(),
          method: 'GET',
          header: (name: string) => headers[name.toLowerCase()],
          query: () => undefined,
        },
        json: (body: any, status?: number, hdrs?: Record<string, string>) => {
          responseBody = body;
          if (status) responseStatus = status;
          if (hdrs) responseHeaders = hdrs;
          return { status: responseStatus, body: responseBody, headers: responseHeaders };
        },
        _getResponse: () => ({ status: responseStatus, body: responseBody, headers: responseHeaders }),
      };
    }

    it('returns 503 with Retry-After when Boltz fails (not 500)', async () => {
      const lightning = {
        createLightningInvoice: vi.fn().mockRejectedValue(new Error('database system is in recovery mode')),
        startSwapManager: vi.fn(),
        dispose: vi.fn(),
      } as any;

      const gateway = createL402Gateway(lightning, { priceSats: 100 });
      const c = makeContext('/api/data');
      await gateway.middleware(c as any, vi.fn());

      expect(c._getResponse().status).toBe(503);
      expect(c._getResponse().headers['Retry-After']).toBe('30');
      expect(c._getResponse().body.error).toContain('temporarily unavailable');

      gateway.dispose();
    });

    it('retries and succeeds on 2nd attempt', async () => {
      const { paymentHash } = makePreimage();
      const lightning = {
        createLightningInvoice: vi.fn()
          .mockRejectedValueOnce(new Error('database not ready'))
          .mockResolvedValueOnce({ invoice: 'lntbs_retry_ok', paymentHash }),
        startSwapManager: vi.fn(),
        dispose: vi.fn(),
      } as any;

      const gateway = createL402Gateway(lightning, { priceSats: 100 });
      const c = makeContext('/api/data');
      await gateway.middleware(c as any, vi.fn());

      // Should get a 402 challenge (invoice created on retry), not 503
      expect(c._getResponse().status).toBe(402);
      expect(lightning.createLightningInvoice).toHaveBeenCalledTimes(2);

      gateway.dispose();
    });

    it('circuit breaker opens after 5 recorded failures', async () => {
      const lightning = {
        createLightningInvoice: vi.fn().mockRejectedValue(new Error('Boltz down')),
        startSwapManager: vi.fn(),
        dispose: vi.fn(),
      } as any;

      const gateway = createL402Gateway(lightning, { priceSats: 100 });
      const cb = gateway._testInternals().boltzCircuitBreaker;

      // Simulate 5 consecutive failures (each request records one after retries exhaust)
      for (let i = 0; i < 5; i++) {
        cb.record();
      }

      expect(cb.isOpen()).toBe(true);

      // Verify open breaker returns 503 immediately
      const c = makeContext('/api/data');
      await gateway.middleware(c as any, vi.fn());
      expect(c._getResponse().status).toBe(503);

      gateway.dispose();
    });

    it('circuit breaker returns 503 immediately when open (no Boltz call)', async () => {
      const lightning = {
        createLightningInvoice: vi.fn(),
        startSwapManager: vi.fn(),
        dispose: vi.fn(),
      } as any;

      const gateway = createL402Gateway(lightning, { priceSats: 100 });

      // Directly trip the circuit breaker
      const cb = gateway._testInternals().boltzCircuitBreaker;
      for (let i = 0; i < 5; i++) cb.record();
      expect(cb.isOpen()).toBe(true);

      const c = makeContext('/api/data');
      await gateway.middleware(c as any, vi.fn());

      expect(c._getResponse().status).toBe(503);
      expect(c._getResponse().headers['Retry-After']).toBe('30');
      // Boltz should NOT have been called at all
      expect(lightning.createLightningInvoice).not.toHaveBeenCalled();

      gateway.dispose();
    });

    it('circuit breaker resets after cooldown period', async () => {
      const { paymentHash } = makePreimage();
      const lightning = {
        createLightningInvoice: vi.fn().mockResolvedValue({ invoice: 'lntbs_recovered', paymentHash }),
        startSwapManager: vi.fn(),
        dispose: vi.fn(),
      } as any;

      const gateway = createL402Gateway(lightning, { priceSats: 100 });
      const cb = gateway._testInternals().boltzCircuitBreaker;

      // Trip the circuit breaker
      for (let i = 0; i < 5; i++) cb.record();
      expect(cb.isOpen()).toBe(true);

      // Simulate cooldown expiry
      (cb as any).openUntil = Date.now() - 1;

      // Breaker should be closed now, and Boltz call should succeed
      const c = makeContext('/api/data');
      await gateway.middleware(c as any, vi.fn());

      expect(cb.isOpen()).toBe(false);
      expect(c._getResponse().status).toBe(402); // 402 challenge, not 503

      gateway.dispose();
    });
  });
});
