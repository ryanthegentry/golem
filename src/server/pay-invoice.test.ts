/**
 * POST /api/pay-invoice — the hosted settlement router's Lightning payer.
 *
 * This route moves real money out of the production hot wallet, so the tests below are mostly
 * about what it REFUSES to do. The route logic under test is the real module; only the auth
 * middleware is mirrored from src/server/index.ts, because that file is a top-level script
 * with wallet-init side effects and cannot be imported in a test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { validateBearerToken } from '../auth/safe-compare.js';
import { createPayInvoiceRoute, resolveCapsFromEnv, type PayInvoiceDeps } from './pay-invoice.js';

const API_KEY = 'test-key';
const AUTH = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

/** A 32-byte preimage and the payment hash it actually hashes to. */
const PREIMAGE = '11'.repeat(32);
const PAYMENT_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');

const INVOICE = 'lnbc10u1ptestinvoice';

interface Stubs {
  lightning: { sendLightningPayment: ReturnType<typeof vi.fn> } | null;
  decode: ReturnType<typeof vi.fn>;
  outflow: { spentToday: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> };
  caps: { maxSatsPerCall: number; maxSatsPerDay: number };
  rateLimit: { timestamps: number[]; max: number; windowMs: number };
}

function makeStubs(overrides: Partial<Stubs> = {}): Stubs {
  return {
    lightning: {
      // SDK settles for slightly more than the invoice amount (swap fees) — the response
      // reports what the SDK says left, which is not necessarily the decoded amount.
      sendLightningPayment: vi.fn().mockResolvedValue({ amount: 1042, preimage: PREIMAGE, txid: 'ark-txid-1' }),
    },
    decode: vi.fn().mockReturnValue({ amountSats: 1000, paymentHash: PAYMENT_HASH }),
    outflow: { spentToday: vi.fn().mockReturnValue(0), record: vi.fn() },
    caps: { maxSatsPerCall: 2000, maxSatsPerDay: 10000 },
    rateLimit: { timestamps: [], max: 10, windowMs: 60_000 },
    ...overrides,
  };
}

/** Mirrors the six auth-middleware lines in src/server/index.ts, using the real validator. */
function createTestApp(stubs: Stubs, apiKey: string | undefined = API_KEY): Hono {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    if (!apiKey) {
      return c.json({ error: 'GOLEM_API_KEY required. Set env var to enable API.' }, 403);
    }
    if (!validateBearerToken(c.req.header('Authorization'), apiKey)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });
  app.route('/api/pay-invoice', createPayInvoiceRoute(stubs as unknown as PayInvoiceDeps));
  return app;
}

function pay(app: Hono, body: Record<string, unknown>, headers: Record<string, string> = AUTH) {
  return app.request('/api/pay-invoice', { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('POST /api/pay-invoice — auth', () => {
  let stubs: Stubs;
  let app: Hono;

  beforeEach(() => {
    stubs = makeStubs();
    app = createTestApp(stubs);
  });

  it('returns 401 without a bearer token', async () => {
    const res = await pay(app, { invoice: INVOICE }, { 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong bearer token', async () => {
    const res = await pay(app, { invoice: INVOICE }, {
      Authorization: 'Bearer wrong-key',
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(401);
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });

  it('returns 403 when no API key is configured (fail-closed)', async () => {
    const res = await pay(createTestApp(stubs, undefined), { invoice: INVOICE });
    expect(res.status).toBe(403);
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });

  it('pays with the correct bearer token', async () => {
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/pay-invoice — preconditions', () => {
  it('returns 503 when lightning is null', async () => {
    const stubs = makeStubs({ lightning: null });
    const res = await pay(createTestApp(stubs), { invoice: INVOICE });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toContain('Lightning unavailable');
  });

  it('checks lightning availability before spending a rate-limit token', async () => {
    const rateLimit = { timestamps: [], max: 10, windowMs: 60_000 };
    const stubs = makeStubs({ lightning: null, rateLimit });
    await pay(createTestApp(stubs), { invoice: INVOICE });
    expect(rateLimit.timestamps).toHaveLength(0);
  });

  it('returns 429 when the rate-limit window is full', async () => {
    const now = Date.now();
    const stubs = makeStubs({
      rateLimit: { timestamps: Array.from({ length: 10 }, () => now), max: 10, windowMs: 60_000 },
    });
    const res = await pay(createTestApp(stubs), { invoice: INVOICE });
    expect(res.status).toBe(429);
    expect((await res.json() as any).error).toContain('Rate limit');
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });

  it('allows a request once stale timestamps age out of the window', async () => {
    const stale = Date.now() - 120_000;
    const stubs = makeStubs({
      rateLimit: { timestamps: Array.from({ length: 10 }, () => stale), max: 10, windowMs: 60_000 },
    });
    const res = await pay(createTestApp(stubs), { invoice: INVOICE });
    expect(res.status).toBe(200);
  });

  it('rate-limits at 10 per minute, matching /api/send', async () => {
    const stubs = makeStubs();
    const app = createTestApp(stubs);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await pay(app, { invoice: INVOICE })).status);
    }
    expect(codes.filter((s) => s === 200)).toHaveLength(10);
    expect(codes[10]).toBe(429);
  });
});

describe('POST /api/pay-invoice — invoice validation', () => {
  let stubs: Stubs;
  let app: Hono;

  beforeEach(() => {
    stubs = makeStubs();
    app = createTestApp(stubs);
  });

  it('returns 400 when invoice is missing', async () => {
    const res = await pay(app, {});
    expect(res.status).toBe(400);
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });

  it('returns 400 when invoice is not a string', async () => {
    const res = await pay(app, { invoice: 12345 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when invoice is empty', async () => {
    const res = await pay(app, { invoice: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await app.request('/api/pay-invoice', { method: 'POST', headers: AUTH, body: '{not json' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the invoice does not decode', async () => {
    stubs.decode.mockImplementation(() => { throw new Error('bad checksum'); });
    const res = await pay(app, { invoice: 'lnbc-garbage' });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid bolt11 invoice');
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });

  it('returns 400 for a zero-amount invoice', async () => {
    stubs.decode.mockReturnValue({ amountSats: 0, paymentHash: PAYMENT_HASH });
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(400);
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('returns 400 for a negative decoded amount', async () => {
    stubs.decode.mockReturnValue({ amountSats: -500, paymentHash: PAYMENT_HASH });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(400);
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-numeric decoded amount rather than paying an uncounted invoice', async () => {
    stubs.decode.mockReturnValue({ amountSats: Number.NaN, paymentHash: PAYMENT_HASH });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(400);
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });
});

describe('POST /api/pay-invoice — spend caps', () => {
  let stubs: Stubs;
  let app: Hono;

  beforeEach(() => {
    stubs = makeStubs();
    app = createTestApp(stubs);
  });

  it('returns 400 OVER_MAX when the invoice exceeds the caller maxSats', async () => {
    const res = await pay(app, { invoice: INVOICE, maxSats: 999 });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe('OVER_MAX');
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('pays when the invoice exactly equals maxSats', async () => {
    expect((await pay(app, { invoice: INVOICE, maxSats: 1000 })).status).toBe(200);
  });

  it('returns 400 when maxSats is present but not a number', async () => {
    const res = await pay(app, { invoice: INVOICE, maxSats: '1' });
    expect(res.status).toBe(400);
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });

  it('returns 400 PER_CALL_CAP when the invoice exceeds the server per-call cap', async () => {
    stubs.decode.mockReturnValue({ amountSats: 2001, paymentHash: PAYMENT_HASH });
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe('PER_CALL_CAP');
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('enforces the per-call cap even when the caller asks for a higher maxSats', async () => {
    stubs.decode.mockReturnValue({ amountSats: 5000, paymentHash: PAYMENT_HASH });
    const res = await pay(app, { invoice: INVOICE, maxSats: 100000 });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('PER_CALL_CAP');
  });

  it('returns 429 DAILY_CAP when today plus this invoice exceeds the day cap', async () => {
    stubs.outflow.spentToday.mockReturnValue(9500);
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.code).toBe('DAILY_CAP');
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('pays when the invoice exactly fills the remaining daily headroom', async () => {
    stubs.outflow.spentToday.mockReturnValue(9000);
    expect((await pay(app, { invoice: INVOICE })).status).toBe(200);
  });

  it('does not pay when the ledger write fails', async () => {
    stubs.outflow.record.mockImplementation(() => { throw new Error('EROFS: read-only file system'); });
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(500);
    expect(stubs.lightning!.sendLightningPayment).not.toHaveBeenCalled();
  });
});

describe('POST /api/pay-invoice — payment', () => {
  let stubs: Stubs;
  let app: Hono;

  beforeEach(() => {
    stubs = makeStubs();
    app = createTestApp(stubs);
  });

  it('pays the invoice and returns the preimage', async () => {
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(200);

    expect(stubs.lightning!.sendLightningPayment).toHaveBeenCalledWith({ invoice: INVOICE });

    const body = await res.json() as any;
    expect(body.preimage).toBe(PREIMAGE);
    expect(body.amountSats).toBe(1042); // what the SDK says left, not the decoded amount
    expect(body.txid).toBe('ark-txid-1');
    expect(typeof body.durationMs).toBe('number');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records the decoded invoice amount against the daily cap', async () => {
    await pay(app, { invoice: INVOICE });
    expect(stubs.outflow.record).toHaveBeenCalledWith(1000);
  });

  it('records the outflow before calling the SDK', async () => {
    const order: string[] = [];
    stubs.outflow.record.mockImplementation(() => { order.push('record'); });
    stubs.lightning!.sendLightningPayment.mockImplementation(async () => {
      order.push('pay');
      return { amount: 1042, preimage: PREIMAGE, txid: 'ark-txid-1' };
    });

    await pay(app, { invoice: INVOICE });
    expect(order).toEqual(['record', 'pay']);
  });

  it('returns 502 PAY_FAILED when the SDK throws, and keeps the reservation', async () => {
    stubs.lightning!.sendLightningPayment.mockRejectedValue(new Error('no route to destination'));
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);

    const body = await res.json() as any;
    expect(body.code).toBe('PAY_FAILED');
    expect(body.error).toBe('no route to destination');

    // Deliberate: a failed attempt eats daily headroom rather than risk uncounted outflow.
    expect(stubs.outflow.record).toHaveBeenCalledWith(1000);
  });

  it('returns 502 PREIMAGE_MISMATCH when the preimage does not hash to the payment hash', async () => {
    stubs.lightning!.sendLightningPayment.mockResolvedValue({
      amount: 1042,
      preimage: '22'.repeat(32),
      txid: 'ark-txid-1',
    });

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);

    const body = await res.json() as any;
    expect(body.code).toBe('PREIMAGE_MISMATCH');
    expect(body.paid).toBe(true); // sats may have left; the caller must reconcile
    expect(body.preimage).toBeUndefined();
    expect(stubs.outflow.record).toHaveBeenCalledWith(1000);
  });

  it('returns 502 PREIMAGE_MISMATCH when the SDK returns no preimage at all', async () => {
    stubs.lightning!.sendLightningPayment.mockResolvedValue({ amount: 1042, txid: 'ark-txid-1' });
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    expect((await res.json() as any).code).toBe('PREIMAGE_MISMATCH');
  });

  it('accepts an uppercase payment hash from the decoder', async () => {
    stubs.decode.mockReturnValue({ amountSats: 1000, paymentHash: PAYMENT_HASH.toUpperCase() });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(200);
  });
});

describe('resolveCapsFromEnv', () => {
  it('defaults to 2000 per call and 10000 per day', () => {
    expect(resolveCapsFromEnv({})).toEqual({ maxSatsPerCall: 2000, maxSatsPerDay: 10000 });
  });

  it('reads the env overrides', () => {
    expect(resolveCapsFromEnv({
      GOLEM_PAY_MAX_SATS_PER_CALL: '500',
      GOLEM_PAY_MAX_SATS_PER_DAY: '5000',
    })).toEqual({ maxSatsPerCall: 500, maxSatsPerDay: 5000 });
  });

  it('falls back to the defaults for unparseable or non-positive values', () => {
    expect(resolveCapsFromEnv({
      GOLEM_PAY_MAX_SATS_PER_CALL: 'lots',
      GOLEM_PAY_MAX_SATS_PER_DAY: '0',
    })).toEqual({ maxSatsPerCall: 2000, maxSatsPerDay: 10000 });
  });
});
