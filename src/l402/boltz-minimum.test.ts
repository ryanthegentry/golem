/**
 * Bug 3: Boltz minimum swap amount validation.
 *
 * Validates that the gateway and internal API reject prices below
 * Boltz's minimum swap amount (333 sats) and clamp cache-discounted
 * prices to that floor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createL402Gateway, BOLTZ_MINIMUM_SATS } from './gateway.js';
import { createInternalApi } from './internal-api.js';
import { MemoryRootKeyStore } from './macaroon.js';
import { ResponseCache } from './response-cache.js';

function makePreimage() {
  const preimage = randomBytes(32).toString('hex');
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex');
  return { preimage, paymentHash };
}

function mockLightning() {
  const { preimage, paymentHash } = makePreimage();
  return {
    preimage,
    paymentHash,
    lightning: {
      createLightningInvoice: vi.fn().mockImplementation(async () => {
        const { paymentHash: ph } = makePreimage();
        return { invoice: 'lntbs500u1ptest...', paymentHash: ph };
      }),
      startSwapManager: vi.fn(),
      dispose: vi.fn(),
    } as any,
  };
}

function makeContext(
  urlPath: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body = '',
) {
  const url = new URL(`http://localhost:8402${urlPath}`);
  let responseStatus = 200;
  let responseBody: any = null;
  let responseHeaders: Record<string, string> = {};

  return {
    req: {
      url: url.toString(),
      method,
      header: (name: string) => headers[name.toLowerCase()],
      query: () => undefined,
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

describe('Bug 3: Boltz minimum swap validation', () => {
  // ─── Gateway creation validation ───────────────────────────────────

  describe('gateway creation', () => {
    it('throws when priceSats is below Boltz minimum (333)', () => {
      const { lightning } = mockLightning();
      expect(() => createL402Gateway(lightning, { priceSats: 100 }))
        .toThrow(/minimum/i);
    });

    it('accepts priceSats at or above Boltz minimum', () => {
      const { lightning } = mockLightning();
      const gw = createL402Gateway(lightning, { priceSats: 500 });
      gw.dispose();
    });
  });

  // ─── Cache-hit price clamping ──────────────────────────────────────

  describe('cache-hit price clamping', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-boltz-min-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('user sees discounted price but Boltz invoice is clamped to minimum (500 * 10% = 50)', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightning();

      const gateway = createL402Gateway(lightning, {
        priceSats: 500,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cachePricePercent: 10, // effective = ceil(500 * 0.10) = 50, below 333
        cacheDefaultTtl: 3600,
      });

      // Pre-populate cache so request is a cache hit
      const key = cache.computeKey('http://localhost:11434/api/data', 'GET', '');
      cache.put(key, {
        upstreamUrl: 'http://localhost:11434/api/data',
        requestMethod: 'GET',
        requestBodyHash: '',
        responseStatus: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: Buffer.from('{"cached":true}'),
      }, 3600);

      const c = makeContext('/api/data');
      await gateway.middleware(c as any, vi.fn());
      const result = c._getResponse();

      expect(result.status).toBe(402);
      // User sees the true cache-discounted price
      expect(result.body.price).toBe(50);
      // But Boltz invoice was created at the minimum (333), not 50
      expect(lightning.createLightningInvoice).toHaveBeenCalledWith({ amount: BOLTZ_MINIMUM_SATS });

      gateway.dispose();
      cache.close();
    });

    it('does not clamp when cache price is above minimum (500 * 80% = 400)', async () => {
      const cache = new ResponseCache(path.join(tmpDir, 'c.db'));
      const { lightning } = mockLightning();

      const gateway = createL402Gateway(lightning, {
        priceSats: 500,
        cache,
        upstreamUrl: 'http://localhost:11434',
        cachePricePercent: 80, // effective = ceil(500 * 0.80) = 400, above 333
        cacheDefaultTtl: 3600,
      });

      // Pre-populate cache
      const key = cache.computeKey('http://localhost:11434/api/data', 'GET', '');
      cache.put(key, {
        upstreamUrl: 'http://localhost:11434/api/data',
        requestMethod: 'GET',
        requestBodyHash: '',
        responseStatus: 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: Buffer.from('{"cached":true}'),
      }, 3600);

      const c = makeContext('/api/data');
      await gateway.middleware(c as any, vi.fn());
      const result = c._getResponse();

      expect(result.status).toBe(402);
      expect(result.body.price).toBe(400);

      gateway.dispose();
      cache.close();
    });
  });

  // ─── Internal API validation ───────────────────────────────────────

  describe('internal API /l402/challenge', () => {
    it('rejects price_sats below Boltz minimum with 400', async () => {
      const { lightning } = mockLightning();

      const app = createInternalApi({
        lightning,
        wallet: {
          getBalance: vi.fn().mockResolvedValue({ total: 1000 }),
          getVtxos: vi.fn().mockResolvedValue([]),
        } as any,
        rootKeyStore: new MemoryRootKeyStore(),
        macaroonStore: {
          register: vi.fn(),
          verify: vi.fn(),
          cleanup: vi.fn(),
          activeCount: vi.fn().mockReturnValue(0),
        } as any,
        networkConfig: {
          golemNetwork: 'mutinynet',
          boltzApiUrl: 'http://localhost',
          arkServerUrl: 'http://localhost',
          mempoolUrl: 'http://localhost',
        } as any,
        startTime: Date.now(),
        apiKey: 'test-key',
      });

      const res = await app.request('/l402/challenge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-key',
        },
        body: JSON.stringify({ price_sats: 100 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/minimum/i);
      // Should NOT have called Boltz
      expect(lightning.createLightningInvoice).not.toHaveBeenCalled();
    });

    it('accepts price_sats at Boltz minimum', async () => {
      const { lightning } = mockLightning();

      const app = createInternalApi({
        lightning,
        wallet: {
          getBalance: vi.fn().mockResolvedValue({ total: 1000 }),
          getVtxos: vi.fn().mockResolvedValue([]),
        } as any,
        rootKeyStore: new MemoryRootKeyStore(),
        macaroonStore: {
          register: vi.fn(),
          verify: vi.fn(),
          cleanup: vi.fn(),
          activeCount: vi.fn().mockReturnValue(0),
        } as any,
        networkConfig: {
          golemNetwork: 'mutinynet',
          boltzApiUrl: 'http://localhost',
          arkServerUrl: 'http://localhost',
          mempoolUrl: 'http://localhost',
        } as any,
        startTime: Date.now(),
        apiKey: 'test-key',
      });

      const res = await app.request('/l402/challenge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-key',
        },
        body: JSON.stringify({ price_sats: 500 }),
      });

      expect(res.status).toBe(200);
    });
  });
});
