/**
 * Tests for POST /api/receive endpoint.
 *
 * Since src/server/index.ts is a top-level script with side effects (wallet init,
 * process.exit, etc.), we replicate the endpoint logic in a lightweight Hono app
 * with mocked dependencies — same pattern as internal-api.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

function createTestApp(options: {
  lightning: any;
  apiKey: string;
  receiveRateLimit?: { timestamps: number[]; max: number; windowMs: number };
}) {
  const { lightning, apiKey } = options;
  const receiveRateLimit = options.receiveRateLimit ?? { timestamps: [], max: 3, windowMs: 60_000 };

  const app = new Hono();

  // Auth middleware (mirrors server)
  app.use('/api/*', async (c, next) => {
    if (!apiKey) {
      return c.json({ error: 'GOLEM_API_KEY required' }, 403);
    }
    const auth = c.req.header('Authorization');
    if (auth !== `Bearer ${apiKey}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  // Receive endpoint (mirrors server implementation exactly)
  app.post('/api/receive', async (c) => {
    if (!lightning) {
      return c.json({ error: 'Lightning unavailable — swap manager failed to start' }, 503);
    }

    const now = Date.now();
    receiveRateLimit.timestamps = receiveRateLimit.timestamps.filter(t => now - t < receiveRateLimit.windowMs);
    if (receiveRateLimit.timestamps.length >= receiveRateLimit.max) {
      return c.json({ error: 'Rate limit exceeded: max 3 receives per minute' }, 429);
    }
    receiveRateLimit.timestamps.push(now);

    try {
      const body = await c.req.json<{ amount: number }>();
      if (!body.amount || typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount <= 0) {
        return c.json({ error: 'amount must be a positive integer (sats)' }, 400);
      }

      const result = await lightning.createLightningInvoice({ amount: body.amount });
      return c.json({
        invoice: result.invoice,
        amount: result.amount,
        swapId: result.pendingSwap.id,
        expiry: result.expiry,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}

const AUTH = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };

function makeRequest(app: Hono, body: Record<string, unknown>, headers = AUTH) {
  return app.request('/api/receive', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/receive', () => {
  let mockLightning: any;
  let app: Hono;

  beforeEach(() => {
    mockLightning = {
      createLightningInvoice: vi.fn().mockResolvedValue({
        invoice: 'lntbs150u1ptest...',
        amount: 14962,
        paymentHash: 'abc123hash',
        preimage: 'secret',
        expiry: 133200,
        pendingSwap: { id: 'swap-123' },
      }),
    };
    app = createTestApp({ lightning: mockLightning, apiKey: 'test-key' });
  });

  it('returns 401 without API key', async () => {
    const res = await app.request('/api/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 15000 }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when lightning is null', async () => {
    const noLnApp = createTestApp({ lightning: null, apiKey: 'test-key' });
    const res = await makeRequest(noLnApp, { amount: 15000 });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('Lightning unavailable');
  });

  it('returns 400 for missing amount', async () => {
    const res = await makeRequest(app, {});
    expect(res.status).toBe(400);
  });

  it('returns 400 for zero amount', async () => {
    const res = await makeRequest(app, { amount: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for negative amount', async () => {
    const res = await makeRequest(app, { amount: -100 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-integer amount', async () => {
    const res = await makeRequest(app, { amount: 15.5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for string amount', async () => {
    const res = await makeRequest(app, { amount: '15000' });
    expect(res.status).toBe(400);
  });

  it('returns invoice on valid request', async () => {
    const res = await makeRequest(app, { amount: 15000 });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.invoice).toBe('lntbs150u1ptest...');
    expect(body.amount).toBe(14962);
    expect(body.swapId).toBe('swap-123');
    expect(body.expiry).toBe(133200);

    // Must NOT leak preimage or paymentHash
    expect(body).not.toHaveProperty('preimage');
    expect(body).not.toHaveProperty('paymentHash');
    expect(body).not.toHaveProperty('pendingSwap');
  });

  it('calls createLightningInvoice with correct amount', async () => {
    await makeRequest(app, { amount: 25000 });
    expect(mockLightning.createLightningInvoice).toHaveBeenCalledWith({ amount: 25000 });
  });

  it('returns 429 when rate limit exceeded', async () => {
    const limitedApp = createTestApp({
      lightning: mockLightning,
      apiKey: 'test-key',
      receiveRateLimit: { timestamps: [Date.now(), Date.now(), Date.now()], max: 3, windowMs: 60_000 },
    });

    const res = await makeRequest(limitedApp, { amount: 15000 });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Rate limit');
  });

  it('returns 500 when createLightningInvoice throws', async () => {
    mockLightning.createLightningInvoice.mockRejectedValueOnce(new Error('Boltz API down'));
    const res = await makeRequest(app, { amount: 15000 });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Boltz API down');
  });
});
