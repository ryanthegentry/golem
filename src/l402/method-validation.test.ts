/**
 * L402 Gateway — Post-auth method validation tests.
 *
 * Verifies that:
 * 1. 402 challenge fires on ANY method (GET, POST, etc.) regardless of upstreamMethod config
 * 2. 402 response body includes `method` hint when upstreamMethod is configured
 * 3. After auth, mismatched methods get 405 (token preserved)
 * 4. After auth, correct method passes through
 * 5. No upstreamMethod config = any method allowed (backward compat)
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  mintL402Macaroon,
  MemoryRootKeyStore,
} from './macaroon.js';
import { createL402Gateway } from './gateway.js';

function makePreimage(): { preimage: string; paymentHash: string } {
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
      createLightningInvoice: vi.fn().mockResolvedValue({
        invoice: 'lntbs10u1ptest...',
        paymentHash,
      }),
      startSwapManager: vi.fn(),
      dispose: vi.fn(),
    } as any,
  };
}

function makeContext(
  urlPath: string,
  method: string,
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

describe('L402 Gateway — post-auth method validation', () => {
  it('402 challenge fires on GET even when upstreamMethod=POST', async () => {
    const { lightning } = mockLightning();
    const gateway = createL402Gateway(lightning, {
      priceSats: 500,
      upstreamMethod: 'POST',
    });

    const c = makeContext('/v1/chat/completions', 'GET');
    const next = vi.fn();
    await gateway.middleware(c as any, next);

    expect(c._getResponse().status).toBe(402);
    expect(next).not.toHaveBeenCalled();
    gateway.dispose();
  });

  it('402 response body includes method hint when upstreamMethod is set', async () => {
    const { lightning } = mockLightning();
    const gateway = createL402Gateway(lightning, {
      priceSats: 500,
      upstreamMethod: 'POST',
    });

    const c = makeContext('/v1/chat/completions', 'GET');
    await gateway.middleware(c as any, vi.fn());

    const body = c._getResponse().body;
    expect(body.method).toBe('POST');
    gateway.dispose();
  });

  it('402 response body omits method hint when upstreamMethod is not set', async () => {
    const { lightning } = mockLightning();
    const gateway = createL402Gateway(lightning, {
      priceSats: 500,
    });

    const c = makeContext('/v1/chat/completions', 'GET');
    await gateway.middleware(c as any, vi.fn());

    const body = c._getResponse().body;
    expect(body.method).toBeUndefined();
    gateway.dispose();
  });

  it('returns 405 when authenticated GET hits POST-only upstream', async () => {
    const { lightning } = mockLightning();
    const gateway = createL402Gateway(lightning, {
      priceSats: 500,
      upstreamMethod: 'POST',
    });

    // Mint a valid token
    const { preimage, paymentHash } = makePreimage();
    const store = gateway._testInternals().rootKeyStore;
    const mac = mintL402Macaroon(store, { paymentHash });

    const c = makeContext('/v1/chat/completions', 'GET', {
      authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
    });
    await gateway.middleware(c as any, vi.fn());

    const resp = c._getResponse();
    expect(resp.status).toBe(405);
    expect(resp.body.error).toBe('Method Not Allowed');
    expect(resp.body.allowed_methods).toEqual(['POST']);
    expect(resp.body.hint).toContain('Your L402 token is still valid');
    gateway.dispose();
  });

  it('allows authenticated POST when upstreamMethod=POST', async () => {
    const { lightning } = mockLightning();
    const gateway = createL402Gateway(lightning, {
      priceSats: 500,
      upstreamMethod: 'POST',
    });

    const { preimage, paymentHash } = makePreimage();
    const store = gateway._testInternals().rootKeyStore;
    const mac = mintL402Macaroon(store, { paymentHash });

    const c = makeContext('/v1/chat/completions', 'POST', {
      authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
    }, '{"model":"llama3"}');
    const next = vi.fn();
    await gateway.middleware(c as any, next);

    // Should pass through to next() (proxy handler)
    expect(next).toHaveBeenCalled();
    gateway.dispose();
  });

  it('allows any method when upstreamMethod is not configured', async () => {
    const { lightning } = mockLightning();
    const gateway = createL402Gateway(lightning, {
      priceSats: 500,
      // No upstreamMethod — any method allowed
    });

    const { preimage, paymentHash } = makePreimage();
    const store = gateway._testInternals().rootKeyStore;
    const mac = mintL402Macaroon(store, { paymentHash });

    const c = makeContext('/api/data', 'GET', {
      authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
    });
    const next = vi.fn();
    await gateway.middleware(c as any, next);

    // Should pass through — no method restriction
    expect(next).toHaveBeenCalled();
    gateway.dispose();
  });

  it('method check is case-insensitive', async () => {
    const { lightning } = mockLightning();
    const gateway = createL402Gateway(lightning, {
      priceSats: 500,
      upstreamMethod: 'post', // lowercase
    });

    const { preimage, paymentHash } = makePreimage();
    const store = gateway._testInternals().rootKeyStore;
    const mac = mintL402Macaroon(store, { paymentHash });

    // POST (uppercase from HTTP) should match
    const c = makeContext('/api/data', 'POST', {
      authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
    }, '{}');
    const next = vi.fn();
    await gateway.middleware(c as any, next);
    expect(next).toHaveBeenCalled();
    gateway.dispose();
  });

  it('onPayment still fires even when method is wrong (payment was valid)', async () => {
    const { lightning } = mockLightning();
    const onPayment = vi.fn();
    const gateway = createL402Gateway(lightning, {
      priceSats: 500,
      upstreamMethod: 'POST',
      onPayment,
    });

    const { preimage, paymentHash } = makePreimage();
    const store = gateway._testInternals().rootKeyStore;
    const mac = mintL402Macaroon(store, { paymentHash });

    const c = makeContext('/api/data', 'GET', {
      authorization: `L402 ${mac.macaroonBase64}:${preimage}`,
    });
    await gateway.middleware(c as any, vi.fn());

    // 405 returned, but payment was valid — callback should fire
    expect(c._getResponse().status).toBe(405);
    expect(onPayment).toHaveBeenCalledWith('lightning', 500, paymentHash);
    gateway.dispose();
  });
});
