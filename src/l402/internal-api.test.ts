/**
 * L402 Internal API tests — /l402/challenge, /l402/verify, /l402/status
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { createInternalApi } from './internal-api.js';
import { MemoryRootKeyStore } from './macaroon.js';
import { MacaroonStore } from './macaroon-store.js';
import { NETWORK_CONFIGS } from '../config/networks.js';

function makePreimage(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString('hex');
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex');
  return { preimage, paymentHash };
}

describe('L402 Internal API', () => {
  let tmpDir: string;
  let macaroonStore: MacaroonStore;
  let rootKeyStore: MemoryRootKeyStore;
  let app: Hono;
  let lastInvoicePaymentHash: string;
  let lastInvoicePreimage: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-internal-api-'));
    macaroonStore = new MacaroonStore(path.join(tmpDir, 'macaroons.db'));
    rootKeyStore = new MemoryRootKeyStore();

    // Generate a fixed preimage/hash for the mock lightning
    const fixture = makePreimage();
    lastInvoicePaymentHash = fixture.paymentHash;
    lastInvoicePreimage = fixture.preimage;

    const mockLightning = {
      createLightningInvoice: vi.fn().mockResolvedValue({
        invoice: 'lntbs500n1ptest...',
        paymentHash: lastInvoicePaymentHash,
      }),
      startSwapManager: vi.fn(),
    } as any;

    const mockWallet = {
      getBalance: vi.fn().mockResolvedValue({
        total: 50000,
        available: 48000,
        settled: 48000,
        boarding: { total: 0, confirmed: 0, unconfirmed: 0 },
        preconfirmed: 0,
        recoverable: 0,
      }),
      getVtxos: vi.fn().mockResolvedValue([
        { txid: 'abc', vout: 0, value: 25000, virtualStatus: { state: 'settled' } },
        { txid: 'def', vout: 1, value: 23000, virtualStatus: { state: 'settled' } },
      ]),
    } as any;

    app = createInternalApi({
      lightning: mockLightning,
      wallet: mockWallet,
      rootKeyStore,
      macaroonStore,
      networkConfig: NETWORK_CONFIGS.mutinynet,
      startTime: Date.now(),
      apiKey: 'test-api-key',
    });
  });

  afterEach(() => {
    macaroonStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /l402/challenge', () => {
    it('returns valid macaroon + invoice format with camelCase fields', async () => {
      const res = await app.request('/l402/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({ priceSats: 500, durationHours: 24 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;

      expect(typeof body.macaroon).toBe('string');
      expect(typeof body.invoice).toBe('string');
      expect(typeof body.paymentHash).toBe('string');
      expect(body.durationHours).toBe(24);
      expect(body.priceSats).toBe(500);
      // expiresAt must be ISO 8601 string — 402index does new Date(result.expiresAt)
      expect(typeof body.expiresAt).toBe('string');
      const parsed = new Date(body.expiresAt as string);
      expect(parsed.getTime()).toBeGreaterThan(Date.now());
      expect((body.expiresAt as string).endsWith('Z')).toBe(true);
    });

    it('accepts price_sats and duration_hours field names', async () => {
      const res = await app.request('/l402/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({ price_sats: 1000, duration_hours: 48 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.priceSats).toBe(1000);
      expect(body.durationHours).toBe(48);
    });

    it('accepts price field name (legacy)', async () => {
      const res = await app.request('/l402/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({ price: 500 }),
      });

      expect(res.status).toBe(200);
    });

    it('registers macaroon in store for anti-replay', async () => {
      const res = await app.request('/l402/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({ priceSats: 500, durationHours: 24 }),
      });

      const body = await res.json() as Record<string, unknown>;
      const storeResult = macaroonStore.verify(body.paymentHash as string);
      expect(storeResult.valid).toBe(true);
    });
  });

  describe('POST /l402/verify', () => {
    it('valid token returns { valid: true, expiresAt: <ISO 8601> }', async () => {
      // First, create a challenge to get a valid macaroon
      const challengeRes = await app.request('/l402/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({ priceSats: 500, durationHours: 24 }),
      });

      const challenge = await challengeRes.json() as Record<string, unknown>;

      // Verify with the correct preimage
      const authorization = `L402 ${challenge.macaroon}:${lastInvoicePreimage}`;
      const verifyRes = await app.request('/l402/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({ authorization }),
      });

      expect(verifyRes.status).toBe(200);
      const result = await verifyRes.json() as { valid: boolean; expiresAt: string };
      expect(result.valid).toBe(true);
      // expiresAt must be ISO 8601 string — 402index does new Date(result.expiresAt)
      expect(typeof result.expiresAt).toBe('string');
      const parsed = new Date(result.expiresAt);
      expect(parsed.getTime()).toBeGreaterThan(Date.now());
      expect(result.expiresAt.endsWith('Z')).toBe(true);
    });

    it('invalid token returns { valid: false, expiresAt: null }', async () => {
      const verifyRes = await app.request('/l402/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({ authorization: 'L402 garbage:also_garbage' }),
      });

      expect(verifyRes.status).toBe(200);
      const result = await verifyRes.json() as { valid: boolean; expiresAt: string | null };
      expect(result.valid).toBe(false);
      expect(result.expiresAt).toBeNull();
    });

    it('expired token returns { valid: false }', async () => {
      vi.useFakeTimers();

      // Create a challenge with 1-second duration
      const challengeRes = await app.request('/l402/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({ priceSats: 500, durationHours: 1 / 3600 }), // 1 second
      });

      const challenge = await challengeRes.json() as Record<string, unknown>;

      // Fast-forward 2 seconds
      vi.advanceTimersByTime(2000);

      const authorization = `L402 ${challenge.macaroon}:${lastInvoicePreimage}`;
      const verifyRes = await app.request('/l402/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({ authorization }),
      });

      const result = await verifyRes.json() as { valid: boolean; expiresAt: number };
      expect(result.valid).toBe(false);

      vi.useRealTimers();
    });

    it('missing authorization returns { valid: false, expiresAt: null }', async () => {
      const verifyRes = await app.request('/l402/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' },
        body: JSON.stringify({}),
      });

      expect(verifyRes.status).toBe(400);
      const result = await verifyRes.json() as { valid: boolean; expiresAt: string | null };
      expect(result.valid).toBe(false);
      expect(result.expiresAt).toBeNull();
    });
  });

  describe('GET /l402/status', () => {
    it('returns all expected fields', async () => {
      const res = await app.request('/l402/status');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;

      expect(typeof body.healthy).toBe('boolean');
      expect(typeof body.network).toBe('string');
      expect(typeof body.walletBalanceSats).toBe('number');
      expect(typeof body.vtxoCount).toBe('number');
      expect(typeof body.activeMacaroons).toBe('number');
      expect(typeof body.uptimeSeconds).toBe('number');
      expect(body.network).toBe('mutinynet');
    });

    it('healthy is true when wallet is accessible', async () => {
      const res = await app.request('/l402/status');
      const body = await res.json() as Record<string, unknown>;
      expect(body.healthy).toBe(true);
    });

    it('reports correct wallet balance', async () => {
      const res = await app.request('/l402/status');
      const body = await res.json() as Record<string, unknown>;
      expect(body.walletBalanceSats).toBe(50000);
      expect(body.vtxoCount).toBe(2);
    });
  });
});
