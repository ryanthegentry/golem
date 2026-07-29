/**
 * POST /api/pay-invoice — pay a bolt11 invoice and return the preimage.
 *
 * Exists so the 402index settlement router can run hosted instead of shelling out to the Golem
 * CLI on a laptop. That means a network-reachable route that spends from the production hot
 * wallet, so the guards here are deliberately independent of whatever the caller believes:
 * the caller's `maxSats` is honoured, but a per-call cap and a persisted daily cap apply on top
 * of it. A stolen router token gets bounded losses, not the wallet.
 *
 * Mounted behind the same fail-closed bearer auth as every other /api route.
 */

import { Hono } from 'hono';
import { createHash } from 'node:crypto';

export interface PayInvoiceDeps {
  /** Null when the swap manager failed to start — the route reports 503 rather than pretending. */
  lightning: {
    sendLightningPayment(args: { invoice: string }): Promise<{ amount: number; preimage: string; txid: string }>;
  } | null;
  decode: (invoice: string) => { amountSats: number; paymentHash: string };
  caps: { maxSatsPerCall: number; maxSatsPerDay: number };
  outflow: { spentToday(): number; record(sats: number): void };
  rateLimit: { timestamps: number[]; max: number; windowMs: number };
}

export const DEFAULT_MAX_SATS_PER_CALL = 2000;
export const DEFAULT_MAX_SATS_PER_DAY = 10000;

/**
 * Caps from the environment, falling back to the defaults for anything unparseable or
 * non-positive. A typo'd env var must not silently disable a spend control.
 */
export function resolveCapsFromEnv(env: Record<string, string | undefined>): {
  maxSatsPerCall: number;
  maxSatsPerDay: number;
} {
  const positive = (raw: string | undefined, fallback: number): number => {
    const parsed = parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    maxSatsPerCall: positive(env.GOLEM_PAY_MAX_SATS_PER_CALL, DEFAULT_MAX_SATS_PER_CALL),
    maxSatsPerDay: positive(env.GOLEM_PAY_MAX_SATS_PER_DAY, DEFAULT_MAX_SATS_PER_DAY),
  };
}

export function createPayInvoiceRoute(deps: PayInvoiceDeps): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const { lightning, decode, caps, outflow, rateLimit } = deps;

    if (!lightning) {
      return c.json({ error: 'Lightning unavailable — swap manager failed to start' }, 503);
    }

    // Same sliding window as /api/send, on its own state: a router hammering this route must
    // not consume the operator's own send budget, and vice versa.
    const now = Date.now();
    rateLimit.timestamps = rateLimit.timestamps.filter((t) => now - t < rateLimit.windowMs);
    if (rateLimit.timestamps.length >= rateLimit.max) {
      return c.json({ error: `Rate limit exceeded: max ${rateLimit.max} payments per minute` }, 429);
    }
    rateLimit.timestamps.push(now);

    let body: { invoice?: unknown; maxSats?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const invoice = typeof body.invoice === 'string' ? body.invoice.trim() : '';
    if (!invoice) {
      return c.json({ error: 'invoice required (bolt11 string)' }, 400);
    }

    // A non-numeric maxSats is a rejection, not something to ignore: the caller sent it because
    // it wanted a ceiling, and dropping it would remove a guard the caller thinks it has.
    let maxSats: number | undefined;
    if (body.maxSats !== undefined && body.maxSats !== null) {
      if (typeof body.maxSats !== 'number' || !Number.isFinite(body.maxSats)) {
        return c.json({ error: 'maxSats must be a number (sats)' }, 400);
      }
      maxSats = body.maxSats;
    }

    let decoded: { amountSats: number; paymentHash: string };
    try {
      decoded = decode(invoice);
    } catch {
      return c.json({ error: 'invalid bolt11 invoice' }, 400);
    }

    const amountSats = decoded.amountSats;
    // Also catches NaN: an unmeasurable amount passes every cap comparison below and would be
    // recorded as NaN, poisoning the day's ledger permanently.
    if (typeof amountSats !== 'number' || !Number.isFinite(amountSats) || amountSats <= 0) {
      return c.json({ error: 'invoice must specify a positive amount — zero-amount invoices are not supported' }, 400);
    }

    if (maxSats !== undefined && amountSats > maxSats) {
      return c.json({ error: `invoice is ${amountSats} sats, over the requested max of ${maxSats}`, code: 'OVER_MAX' }, 400);
    }

    if (amountSats > caps.maxSatsPerCall) {
      return c.json({ error: `invoice is ${amountSats} sats, over the per-call cap of ${caps.maxSatsPerCall}`, code: 'PER_CALL_CAP' }, 400);
    }

    const spent = outflow.spentToday();
    if (spent + amountSats > caps.maxSatsPerDay) {
      return c.json({
        error: `daily outflow cap reached: ${spent} of ${caps.maxSatsPerDay} sats spent today, ` +
          `this invoice needs ${amountSats}`,
        code: 'DAILY_CAP',
      }, 429);
    }

    // Reserve BEFORE paying, and deliberately do NOT release the reservation on failure.
    // A failed attempt eating daily headroom is a bounded annoyance that resets at midnight
    // UTC; money leaving the wallet without being counted is the exact failure this cap
    // exists to prevent. The SDK auto-refunds pre-settlement failures, but the cap does not
    // trust that — a refund we did not observe still has to be assumed spent.
    //
    // A throw here (read-only volume, full disk) propagates and no payment is attempted.
    // Failing to remember a spend is a reason not to spend.
    outflow.record(amountSats);

    const startedAt = Date.now();
    let result: { amount: number; preimage: string; txid: string };
    try {
      result = await lightning.sendLightningPayment({ invoice });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), code: 'PAY_FAILED' }, 502);
    }
    const durationMs = Date.now() - startedAt;

    // The preimage is the only proof the invoice was actually settled, and it is what the
    // caller will present as an L402 token. Verify it against the payment hash we decoded
    // ourselves rather than trusting the swap provider's word.
    const preimage = typeof result.preimage === 'string' ? result.preimage : '';
    const hash = preimage ? createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') : '';
    if (!preimage || hash !== decoded.paymentHash.toLowerCase()) {
      return c.json({
        error: 'preimage does not match payment hash',
        code: 'PREIMAGE_MISMATCH',
        paid: true, // sats may have left the wallet — the caller has to reconcile, not retry
      }, 502);
    }

    return c.json({ preimage, amountSats: result.amount, txid: result.txid, durationMs });
  });

  return app;
}
