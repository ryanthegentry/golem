/**
 * POST /api/pay-invoice — the hosted settlement router's Lightning payer.
 *
 * This route moves real money out of the production hot wallet, so the tests below are mostly
 * about what it REFUSES to do. The route logic under test is the real module; only the auth
 * middleware is mirrored from src/server/index.ts, because that file is a top-level script
 * with wallet-init side effects and cannot be imported in a test.
 *
 * Red-team 2026-07-29 drove the shape of most of this file. The headline: the caps must meter
 * what the WALLET IS DEBITED (`expectedAmount`, a number Boltz supplies), not the face value
 * of the invoice. So the route splits create-swap from fund-swap, bounds the quote, and only
 * then spends.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { TransactionFailedError, PreimageFetchError } from '@arkade-os/boltz-swap';
import { validateBearerToken } from '../auth/safe-compare.js';
import {
  createPayInvoiceRoute,
  resolveCapsFromEnv,
  maxAcceptableDebitSats,
  FEE_TOLERANCE_MULTIPLIER,
  FEE_TOLERANCE_FLAT_SATS,
  type PayInvoiceDeps,
} from './pay-invoice.js';

const API_KEY = 'test-key';
const AUTH = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

/** A 32-byte preimage and the payment hash it actually hashes to. */
const PREIMAGE = '11'.repeat(32);
const PAYMENT_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');

const INVOICE = 'lnbc10u1ptestinvoice';
const AMOUNT = 1000;
/** Inside the fee bound: 1000 * 1.02 + 21 = 1041. */
const EXPECTED = 1035;
const SWAP = { id: 'swap-1', response: { address: 'ark1qswaplockup', expectedAmount: EXPECTED } };

interface Stubs {
  lightning: {
    createSubmarineSwap: ReturnType<typeof vi.fn>;
    waitForSwapSettlement: ReturnType<typeof vi.fn>;
    refundVHTLC: ReturnType<typeof vi.fn>;
  } | null;
  send: ReturnType<typeof vi.fn>;
  decode: ReturnType<typeof vi.fn>;
  outflow: {
    spentToday: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  caps: { maxSatsPerCall: number; maxSatsPerDay: number };
  rateLimit: { timestamps: number[]; max: number; windowMs: number };
  audit: ReturnType<typeof vi.fn>;
  timeoutMs: number;
  payApiKey?: string;
  requirePrivateHost?: boolean;
}

function makeStubs(overrides: Partial<Stubs> = {}): Stubs {
  return {
    lightning: {
      createSubmarineSwap: vi.fn().mockResolvedValue(SWAP),
      waitForSwapSettlement: vi.fn().mockResolvedValue({ preimage: PREIMAGE }),
      refundVHTLC: vi.fn().mockResolvedValue(undefined),
    },
    send: vi.fn().mockResolvedValue('ark-txid-1'),
    decode: vi.fn().mockReturnValue({ amountSats: AMOUNT, paymentHash: PAYMENT_HASH }),
    outflow: { spentToday: vi.fn().mockReturnValue(0), record: vi.fn(), release: vi.fn() },
    caps: { maxSatsPerCall: 2000, maxSatsPerDay: 10000 },
    rateLimit: { timestamps: [], max: 10, windowMs: 60_000 },
    audit: vi.fn(),
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** Mirrors the auth middleware in src/server/index.ts, using the real validator. */
function createTestApp(stubs: Stubs, opts: { apiKey?: string | undefined } = {}): Hono {
  // `in`, not `??`: `{ apiKey: undefined }` is the unconfigured-key case, not "use the default".
  const apiKey = 'apiKey' in opts ? opts.apiKey : API_KEY;
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    if (!apiKey) {
      return c.json({ error: 'GOLEM_API_KEY required. Set env var to enable API.' }, 403);
    }
    // A dedicated pay key replaces the primary key on this route, so the primary check is
    // skipped here and the route enforces the stronger credential itself.
    if (stubs.payApiKey && c.req.path === '/api/pay-invoice') return next();
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
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong bearer token', async () => {
    const res = await pay(app, { invoice: INVOICE }, {
      Authorization: 'Bearer wrong-key',
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(401);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('returns 403 when no API key is configured (fail-closed)', async () => {
    const res = await pay(createTestApp(stubs, { apiKey: undefined }), { invoice: INVOICE });
    expect(res.status).toBe(403);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('pays with the correct bearer token', async () => {
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/pay-invoice — dedicated pay key (perimeter)', () => {
  it('rejects the primary API key when a dedicated pay key is configured', async () => {
    // The primary key is compromised-at-rest; it must not be a spend credential.
    const stubs = makeStubs({ payApiKey: 'pay-only-key' });
    const res = await pay(createTestApp(stubs), { invoice: INVOICE });
    expect(res.status).toBe(401);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('accepts the dedicated pay key', async () => {
    const stubs = makeStubs({ payApiKey: 'pay-only-key' });
    const res = await pay(createTestApp(stubs), { invoice: INVOICE }, {
      Authorization: 'Bearer pay-only-key',
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(200);
  });

  it('falls back to the primary key when no dedicated key is set', async () => {
    const stubs = makeStubs();
    expect((await pay(createTestApp(stubs), { invoice: INVOICE })).status).toBe(200);
  });
});

describe('POST /api/pay-invoice — private-host requirement (perimeter)', () => {
  function payTo(app: Hono, url: string) {
    return app.request(url, { method: 'POST', headers: AUTH, body: JSON.stringify({ invoice: INVOICE }) });
  }

  it('is off by default — a public host is accepted', async () => {
    const stubs = makeStubs();
    expect((await payTo(createTestApp(stubs), 'http://golem.up.railway.app/api/pay-invoice')).status).toBe(200);
  });

  it('rejects a non-private host when enabled', async () => {
    const stubs = makeStubs({ requirePrivateHost: true });
    const res = await payTo(createTestApp(stubs), 'http://golem.up.railway.app/api/pay-invoice');
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe('PRIVATE_HOST_REQUIRED');
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('accepts a .railway.internal host when enabled', async () => {
    const stubs = makeStubs({ requirePrivateHost: true });
    expect((await payTo(createTestApp(stubs), 'http://golem.railway.internal/api/pay-invoice')).status).toBe(200);
  });

  it('is not fooled by a lookalike host', async () => {
    const stubs = makeStubs({ requirePrivateHost: true });
    const res = await payTo(createTestApp(stubs), 'http://evil-railway.internal.attacker.com/api/pay-invoice');
    expect(res.status).toBe(403);
  });

  it('accepts a private host carrying a port', async () => {
    const stubs = makeStubs({ requirePrivateHost: true });
    expect((await payTo(createTestApp(stubs), 'http://golem.railway.internal:8402/api/pay-invoice')).status).toBe(200);
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
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('allows a request once stale timestamps age out of the window', async () => {
    const stale = Date.now() - 120_000;
    const stubs = makeStubs({
      rateLimit: { timestamps: Array.from({ length: 10 }, () => stale), max: 10, windowMs: 60_000 },
    });
    expect((await pay(createTestApp(stubs), { invoice: INVOICE })).status).toBe(200);
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

  it('rejects a body over 8KB with 413 before parsing it (MEDIUM-005)', async () => {
    const stubs = makeStubs();
    const res = await pay(createTestApp(stubs), { invoice: INVOICE, padding: 'x'.repeat(9000) });
    expect(res.status).toBe(413);
    expect(stubs.decode).not.toHaveBeenCalled();
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('accepts an ordinary small body', async () => {
    const stubs = makeStubs();
    expect((await pay(createTestApp(stubs), { invoice: INVOICE })).status).toBe(200);
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
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('returns 400 when invoice is not a string', async () => {
    expect((await pay(app, { invoice: 12345 })).status).toBe(400);
  });

  it('returns 400 when invoice is empty', async () => {
    expect((await pay(app, { invoice: '   ' })).status).toBe(400);
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
    expect(stubs.lightning!.createSubmarineSwap).not.toHaveBeenCalled();
  });

  it('returns 400 for a zero-amount invoice', async () => {
    stubs.decode.mockReturnValue({ amountSats: 0, paymentHash: PAYMENT_HASH });
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(400);
    expect(stubs.send).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('returns 400 for a negative decoded amount', async () => {
    stubs.decode.mockReturnValue({ amountSats: -500, paymentHash: PAYMENT_HASH });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(400);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-numeric decoded amount rather than paying an uncounted invoice', async () => {
    stubs.decode.mockReturnValue({ amountSats: Number.NaN, paymentHash: PAYMENT_HASH });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(400);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('returns 400 when the invoice carries no payment hash (MEDIUM-003)', async () => {
    // decodeInvoice yields "" for an invoice with no BOLT11 `p` tag. Paying it produces sats
    // out and no usable credential, and the mismatch is only discovered after the money moves.
    stubs.decode.mockReturnValue({ amountSats: AMOUNT, paymentHash: '' });
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('INVALID_PAYMENT_HASH');
    expect(stubs.lightning!.createSubmarineSwap).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('returns 400 when the payment hash is not 64 hex characters', async () => {
    stubs.decode.mockReturnValue({ amountSats: AMOUNT, paymentHash: 'abc123' });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(400);
  });

  it('returns 400 when the payment hash is 64 chars of non-hex', async () => {
    stubs.decode.mockReturnValue({ amountSats: AMOUNT, paymentHash: 'z'.repeat(64) });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(400);
  });
});

describe('POST /api/pay-invoice — spend caps on the invoice amount', () => {
  let stubs: Stubs;
  let app: Hono;

  beforeEach(() => {
    stubs = makeStubs();
    app = createTestApp(stubs);
  });

  it('returns 400 OVER_MAX when the invoice exceeds the caller maxSats', async () => {
    const res = await pay(app, { invoice: INVOICE, maxSats: 999 });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('OVER_MAX');
    expect(stubs.lightning!.createSubmarineSwap).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('pays when the invoice exactly equals maxSats', async () => {
    expect((await pay(app, { invoice: INVOICE, maxSats: 1000 })).status).toBe(200);
  });

  it('returns 400 when maxSats is present but not a number', async () => {
    expect((await pay(app, { invoice: INVOICE, maxSats: '1' })).status).toBe(400);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('returns 400 PER_CALL_CAP when the invoice exceeds the server per-call cap', async () => {
    stubs.decode.mockReturnValue({ amountSats: 2001, paymentHash: PAYMENT_HASH });
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('PER_CALL_CAP');
    // Rejected before any Boltz round trip — no orphaned swap row.
    expect(stubs.lightning!.createSubmarineSwap).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('enforces the per-call cap even when the caller asks for a higher maxSats', async () => {
    stubs.decode.mockReturnValue({ amountSats: 5000, paymentHash: PAYMENT_HASH });
    const res = await pay(app, { invoice: INVOICE, maxSats: 100000 });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('PER_CALL_CAP');
  });

  it('returns 403 DAILY_CAP when today plus this invoice exceeds the day cap (MEDIUM-006)', async () => {
    // 403, not 429: 429 means "retry later" to every mainstream HTTP client, and this
    // condition does not clear until the UTC boundary. Nothing should auto-retry it.
    stubs.outflow.spentToday.mockReturnValue(9500);
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe('DAILY_CAP');
    expect(stubs.send).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('pays when the invoice exactly fills the remaining daily headroom', async () => {
    stubs.outflow.spentToday.mockReturnValue(10000 - EXPECTED);
    expect((await pay(app, { invoice: INVOICE })).status).toBe(200);
  });
});

describe('POST /api/pay-invoice — the quote bounds the real debit (CRITICAL-001)', () => {
  let stubs: Stubs;
  let app: Hono;

  beforeEach(() => {
    stubs = makeStubs();
    app = createTestApp(stubs);
  });

  it('funds the swap with the quoted expectedAmount, at the quoted address', async () => {
    await pay(app, { invoice: INVOICE });
    expect(stubs.lightning!.createSubmarineSwap).toHaveBeenCalledWith({ invoice: INVOICE });
    expect(stubs.send).toHaveBeenCalledWith({ address: 'ark1qswaplockup', amount: EXPECTED });
  });

  it('meters the daily cap on the real debit, not the invoice face value', async () => {
    await pay(app, { invoice: INVOICE });
    expect(stubs.outflow.record).toHaveBeenCalledWith(EXPECTED);
    expect(stubs.outflow.record).not.toHaveBeenCalledWith(AMOUNT);
  });

  it('rejects a quote above the fee tolerance without spending', async () => {
    // A hostile or buggy Boltz returning the whole balance for a 1,000-sat invoice.
    stubs.lightning!.createSubmarineSwap.mockResolvedValue({
      id: 'swap-evil',
      response: { address: 'ark1qattacker', expectedAmount: 34882 },
    });

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.code).toBe('SWAP_QUOTE_REJECTED');
    expect(body.paid).toBe(false);

    expect(stubs.send).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('accepts a quote exactly at the fee tolerance', async () => {
    const atBound = maxAcceptableDebitSats(AMOUNT);
    expect(atBound).toBe(1041); // 1000 * 1.02 + 21
    stubs.lightning!.createSubmarineSwap.mockResolvedValue({
      id: 'swap-1', response: { address: 'ark1q', expectedAmount: atBound },
    });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(200);
  });

  it('rejects a quote one sat above the fee tolerance', async () => {
    stubs.lightning!.createSubmarineSwap.mockResolvedValue({
      id: 'swap-1', response: { address: 'ark1q', expectedAmount: maxAcceptableDebitSats(AMOUNT) + 1 },
    });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(502);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('rejects a quote below the invoice amount as nonsense', async () => {
    stubs.lightning!.createSubmarineSwap.mockResolvedValue({
      id: 'swap-1', response: { address: 'ark1q', expectedAmount: AMOUNT - 1 },
    });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(502);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('rejects a quote with a missing or non-numeric expectedAmount', async () => {
    stubs.lightning!.createSubmarineSwap.mockResolvedValue({ id: 'swap-1', response: { address: 'ark1q' } });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(502);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('rejects a quote with no lockup address', async () => {
    stubs.lightning!.createSubmarineSwap.mockResolvedValue({
      id: 'swap-1', response: { expectedAmount: EXPECTED },
    });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(502);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('applies the per-call cap to the real debit, not just the face value', async () => {
    // Face value is inside the cap; the quoted debit is not.
    stubs.caps.maxSatsPerCall = 1020;
    stubs.lightning!.createSubmarineSwap.mockResolvedValue({
      id: 'swap-1', response: { address: 'ark1q', expectedAmount: 1035 },
    });

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('PER_CALL_CAP');
    expect(stubs.send).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('applies the daily cap to the real debit, not just the face value', async () => {
    stubs.outflow.spentToday.mockReturnValue(9000); // 9000 + 1000 fits, 9000 + 1035 does not
    stubs.caps.maxSatsPerDay = 10020;

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe('DAILY_CAP');
    expect(stubs.send).not.toHaveBeenCalled();
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('returns 502 when the swap cannot be created, having spent nothing', async () => {
    stubs.lightning!.createSubmarineSwap.mockRejectedValue(new Error('Boltz API error: 429'));
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.code).toBe('SWAP_CREATE_FAILED');
    expect(body.paid).toBe(false);
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('exposes the tolerance constants it enforces', () => {
    expect(FEE_TOLERANCE_MULTIPLIER).toBe(1.02);
    expect(FEE_TOLERANCE_FLAT_SATS).toBe(21);
    expect(maxAcceptableDebitSats(2000)).toBe(2061);
  });
});

describe('POST /api/pay-invoice — payment outcomes', () => {
  let stubs: Stubs;
  let app: Hono;

  beforeEach(() => {
    stubs = makeStubs();
    app = createTestApp(stubs);
  });

  it('pays the invoice and returns the preimage', async () => {
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.preimage).toBe(PREIMAGE);
    expect(body.amountSats).toBe(AMOUNT);
    expect(body.debitedSats).toBe(EXPECTED);
    expect(body.txid).toBe('ark-txid-1');
    expect(typeof body.durationMs).toBe('number');
  });

  it('reserves the debit before funding the swap', async () => {
    const order: string[] = [];
    stubs.outflow.record.mockImplementation(() => { order.push('record'); });
    stubs.send.mockImplementation(async () => { order.push('send'); return 'ark-txid-1'; });

    await pay(app, { invoice: INVOICE });
    expect(order).toEqual(['record', 'send']);
  });

  it('returns 503 and does not spend when the ledger is unreadable (HIGH-004)', async () => {
    const err = new Error('ledger unreadable');
    err.name = 'OutflowLedgerUnreadableError';
    stubs.outflow.spentToday.mockImplementation(() => { throw err; });

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toContain('outflow ledger unreadable');
    expect(stubs.lightning!.createSubmarineSwap).not.toHaveBeenCalled();
    expect(stubs.send).not.toHaveBeenCalled();
  });

  it('returns 502 INSUFFICIENT_FUNDS and releases the reservation when the wallet cannot fund', async () => {
    // Provably clean: the Ark SDK throws before broadcasting anything.
    stubs.send.mockRejectedValue(new Error('Insufficient funds'));

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.code).toBe('INSUFFICIENT_FUNDS');
    expect(body.paid).toBe(false);
    expect(stubs.outflow.release).toHaveBeenCalledWith(EXPECTED);
  });

  it('keeps the reservation when funding fails ambiguously', async () => {
    stubs.send.mockRejectedValue(new Error('socket hang up'));

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.code).toBe('PAY_AMBIGUOUS');
    expect(body.paid).toBe(true);
    expect(stubs.outflow.release).not.toHaveBeenCalled();
  });

  it('returns 502 PAY_FAILED and releases the reservation on TransactionFailedError (HIGH-003)', async () => {
    stubs.lightning!.waitForSwapSettlement.mockRejectedValue(
      new TransactionFailedError({ message: 'no route to destination', isRefundable: true }),
    );

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.code).toBe('PAY_FAILED');
    expect(body.paid).toBe(false);

    // Auto-refund semantics: the sats come back, so the headroom does too.
    expect(stubs.outflow.release).toHaveBeenCalledWith(EXPECTED);
  });

  it('attempts the refund itself on a refundable failure', async () => {
    stubs.lightning!.waitForSwapSettlement.mockRejectedValue(
      new TransactionFailedError({ message: 'failed', isRefundable: true }),
    );
    await pay(app, { invoice: INVOICE });
    expect(stubs.lightning!.refundVHTLC).toHaveBeenCalledWith(SWAP);
  });

  it('still answers when the refund attempt itself throws', async () => {
    stubs.lightning!.waitForSwapSettlement.mockRejectedValue(
      new TransactionFailedError({ message: 'failed', isRefundable: true }),
    );
    stubs.lightning!.refundVHTLC.mockRejectedValue(new Error('VHTLC not found for address'));

    const res = await pay(app, { invoice: INVOICE });
    // The refund could not be confirmed, so the outcome is no longer provably clean.
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.paid).toBe(true);
    expect(stubs.outflow.release).not.toHaveBeenCalled();
  });

  it('returns 502 PREIMAGE_UNAVAILABLE and keeps the reservation on PreimageFetchError (HIGH-003)', async () => {
    stubs.lightning!.waitForSwapSettlement.mockRejectedValue(new PreimageFetchError({ message: 'preimage fetch failed' }));

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.code).toBe('PREIMAGE_UNAVAILABLE');
    expect(body.paid).toBe(true);
    expect(stubs.outflow.release).not.toHaveBeenCalled();
  });

  it('returns 502 PAY_AMBIGUOUS for any other settlement throw (HIGH-003, Cascade 1)', async () => {
    // The real "settled but the preimage GET failed" path in boltz-swap 0.3.56 rejects with a
    // raw provider error, not a typed one. Defaulting it to "paid" is what stops the router
    // from paying the same invoice twice.
    stubs.lightning!.waitForSwapSettlement.mockRejectedValue(new Error('Boltz API error: 502 Bad Gateway'));

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.code).toBe('PAY_AMBIGUOUS');
    expect(body.paid).toBe(true);
    expect(stubs.outflow.release).not.toHaveBeenCalled();
  });

  it('does not attempt a refund on a non-refundable failure', async () => {
    stubs.lightning!.waitForSwapSettlement.mockRejectedValue(new Error('Boltz API error: 502'));
    await pay(app, { invoice: INVOICE });
    expect(stubs.lightning!.refundVHTLC).not.toHaveBeenCalled();
  });

  it('returns 502 PREIMAGE_MISMATCH when the preimage does not hash to the payment hash', async () => {
    stubs.lightning!.waitForSwapSettlement.mockResolvedValue({ preimage: '22'.repeat(32) });

    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.code).toBe('PREIMAGE_MISMATCH');
    expect(body.paid).toBe(true);
    expect(body.preimage).toBeUndefined();
    expect(stubs.outflow.release).not.toHaveBeenCalled();
  });

  it('returns 502 PREIMAGE_MISMATCH when settlement yields no preimage at all', async () => {
    stubs.lightning!.waitForSwapSettlement.mockResolvedValue({});
    const res = await pay(app, { invoice: INVOICE });
    expect(res.status).toBe(502);
    expect((await res.json() as any).code).toBe('PREIMAGE_MISMATCH');
  });

  it('accepts an uppercase payment hash from the decoder', async () => {
    stubs.decode.mockReturnValue({ amountSats: AMOUNT, paymentHash: PAYMENT_HASH.toUpperCase() });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(200);
  });
});

describe('POST /api/pay-invoice — timeout (HIGH-002)', () => {
  it('returns 504 PAY_TIMEOUT when settlement outruns the deadline, keeping the reservation', async () => {
    const stubs = makeStubs({ timeoutMs: 20 });
    // Never settles — the shape of a stalled route or a dead Boltz connection.
    stubs.lightning!.waitForSwapSettlement.mockImplementation(() => new Promise(() => {}));

    const res = await pay(createTestApp(stubs), { invoice: INVOICE });
    expect(res.status).toBe(504);
    const body = await res.json() as any;
    expect(body.code).toBe('PAY_TIMEOUT');
    expect(body.paid).toBe(true); // funds are committed; the SwapManager keeps monitoring
    expect(stubs.outflow.release).not.toHaveBeenCalled();
  });

  it('returns 504 with paid false when the swap quote itself times out', async () => {
    const stubs = makeStubs({ timeoutMs: 20 });
    stubs.lightning!.createSubmarineSwap.mockImplementation(() => new Promise(() => {}));

    const res = await pay(createTestApp(stubs), { invoice: INVOICE });
    expect(res.status).toBe(504);
    const body = await res.json() as any;
    expect(body.code).toBe('PAY_TIMEOUT');
    expect(body.paid).toBe(false); // nothing was funded
    expect(stubs.outflow.record).not.toHaveBeenCalled();
  });

  it('does not reject the underlying settlement promise, so refund monitoring survives', async () => {
    const stubs = makeStubs({ timeoutMs: 20 });
    let settled = false;
    stubs.lightning!.waitForSwapSettlement.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => { settled = true; resolve({ preimage: PREIMAGE }); }, 60)),
    );

    await pay(createTestApp(stubs), { invoice: INVOICE });
    await new Promise((r) => setTimeout(r, 80));
    expect(settled).toBe(true); // the SDK promise ran to completion on its own
  });
});

describe('POST /api/pay-invoice — audit trail (HIGH-005)', () => {
  let stubs: Stubs;
  let app: Hono;

  beforeEach(() => {
    stubs = makeStubs();
    app = createTestApp(stubs);
  });

  it('audits a successful payment without the preimage or the invoice', async () => {
    await pay(app, { invoice: INVOICE });

    expect(stubs.audit).toHaveBeenCalledTimes(1);
    const entry = stubs.audit.mock.calls[0][0];
    expect(entry).toMatchObject({
      paymentHash: PAYMENT_HASH,
      amountSats: AMOUNT,
      expectedAmountSats: EXPECTED,
      outcome: 'paid',
    });
    expect(typeof entry.ts).toBe('number');
    expect(JSON.stringify(entry)).not.toContain(PREIMAGE);
    expect(JSON.stringify(entry)).not.toContain(INVOICE);
  });

  it('audits a cap rejection with its code', async () => {
    stubs.decode.mockReturnValue({ amountSats: 5000, paymentHash: PAYMENT_HASH });
    await pay(app, { invoice: INVOICE });

    expect(stubs.audit).toHaveBeenCalledTimes(1);
    expect(stubs.audit.mock.calls[0][0]).toMatchObject({ outcome: 'rejected', code: 'PER_CALL_CAP', amountSats: 5000 });
  });

  it('audits a failed payment', async () => {
    stubs.lightning!.waitForSwapSettlement.mockRejectedValue(new Error('Boltz API error: 502'));
    await pay(app, { invoice: INVOICE });
    expect(stubs.audit.mock.calls[0][0]).toMatchObject({ outcome: 'failed', code: 'PAY_AMBIGUOUS' });
  });

  it('audits a rejected quote', async () => {
    stubs.lightning!.createSubmarineSwap.mockResolvedValue({
      id: 's', response: { address: 'ark1q', expectedAmount: 34882 },
    });
    await pay(app, { invoice: INVOICE });
    expect(stubs.audit.mock.calls[0][0]).toMatchObject({
      outcome: 'rejected',
      code: 'SWAP_QUOTE_REJECTED',
      expectedAmountSats: 34882,
    });
  });

  it('does not let an audit failure break a payment', async () => {
    stubs.audit.mockImplementation(() => { throw new Error('disk full'); });
    expect((await pay(app, { invoice: INVOICE })).status).toBe(200);
  });
});

describe('resolveCapsFromEnv', () => {
  it('defaults to 2000 per call and 10000 per day', () => {
    expect(resolveCapsFromEnv({})).toMatchObject({ maxSatsPerCall: 2000, maxSatsPerDay: 10000 });
  });

  it('reads the env overrides', () => {
    expect(resolveCapsFromEnv({
      GOLEM_PAY_MAX_SATS_PER_CALL: '500',
      GOLEM_PAY_MAX_SATS_PER_DAY: '5000',
    })).toMatchObject({ maxSatsPerCall: 500, maxSatsPerDay: 5000 });
  });

  it('falls back to the defaults for unparseable or non-positive values', () => {
    expect(resolveCapsFromEnv({
      GOLEM_PAY_MAX_SATS_PER_CALL: 'lots',
      GOLEM_PAY_MAX_SATS_PER_DAY: '0',
    })).toMatchObject({ maxSatsPerCall: 2000, maxSatsPerDay: 10000 });
  });

  it('clamps an absurd per-day cap to the ceiling (LOW-001)', () => {
    // A fat-fingered value parses fine and is finite; only an upper bound catches it.
    expect(resolveCapsFromEnv({ GOLEM_PAY_MAX_SATS_PER_DAY: '50000000000000000000' }).maxSatsPerDay).toBe(1_000_000);
  });

  it('clamps an absurd per-call cap to the ceiling', () => {
    expect(resolveCapsFromEnv({
      GOLEM_PAY_MAX_SATS_PER_CALL: '999999999',
      GOLEM_PAY_MAX_SATS_PER_DAY: '1000000',
    }).maxSatsPerCall).toBe(100_000);
  });

  it('lowers a per-call cap that exceeds the per-day cap, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const caps = resolveCapsFromEnv({
      GOLEM_PAY_MAX_SATS_PER_CALL: '9000',
      GOLEM_PAY_MAX_SATS_PER_DAY: '5000',
    });
    expect(caps).toMatchObject({ maxSatsPerCall: 5000, maxSatsPerDay: 5000 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads the payment timeout, defaulting to 120s', () => {
    expect(resolveCapsFromEnv({}).timeoutMs).toBe(120_000);
    expect(resolveCapsFromEnv({ GOLEM_PAY_TIMEOUT_MS: '30000' }).timeoutMs).toBe(30_000);
    expect(resolveCapsFromEnv({ GOLEM_PAY_TIMEOUT_MS: 'soon' }).timeoutMs).toBe(120_000);
  });
});
