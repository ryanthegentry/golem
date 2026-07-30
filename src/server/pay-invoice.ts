/**
 * POST /api/pay-invoice — pay a bolt11 invoice and return the preimage.
 *
 * Exists so the 402index settlement router can run hosted instead of shelling out to the Golem
 * CLI on a laptop. That means a network-reachable route that spends from the production hot
 * wallet, so the guards here are deliberately independent of whatever the caller believes.
 *
 * ## Why this does not call `sendLightningPayment`
 *
 * The SDK's one-shot helper does `createSubmarineSwap` → `wallet.send(expectedAmount)` with no
 * bound on `expectedAmount`, a number Boltz supplies verbatim in its JSON response. There is no
 * max-fee parameter and no slippage tolerance anywhere on the submarine path (the SDK ships
 * `maxSlippageBps` for chain swaps and never wired it to this one). Metering caps on the
 * invoice's face value therefore capped a different quantity than the one leaving the wallet:
 * a 1,000-sat invoice could debit the entire balance and the ledger would record 1,000.
 * That is red-team 2026-07-29 CRITICAL-001, and Cascade 4 reaches it with no attacker at all —
 * an ordinary mempool fee spike is enough.
 *
 * So the route drives the two phases itself: quote the swap, bound the quote, meter the caps on
 * the real debit, and only then fund it. The phases are public SDK surface
 * (`createSubmarineSwap` / `waitForSwapSettlement` / `refundVHTLC`), so this is composition,
 * not reimplementation.
 *
 * ## The caller contract
 *
 * Every failure response carries `paid`. Only `paid: false` is safe to retry. Any ambiguous
 * outcome reports `paid: true`, because the alternative — a router that retries an invoice that
 * actually settled — pays twice (Cascade 1).
 *
 * Note `deps.send` is the raw SDK wallet send, which bypasses GolemWallet's OOR limit and send
 * lock exactly as `sendLightningPayment` did. That is red-team HIGH-001, left open deliberately;
 * routing it through `GolemWallet.sendBitcoin` is a one-line change at the injection site.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash } from 'node:crypto';
import { TransactionFailedError, PreimageFetchError } from '@arkade-os/boltz-swap';
import { validateBearerToken } from '../auth/safe-compare.js';
import type { PayAuditEntry } from './pay-audit.js';

/** The shape of a pending submarine swap this route depends on. */
export interface SubmarineQuote {
  id: string;
  response: { address?: string; expectedAmount?: number };
}

export interface PayInvoiceDeps {
  /** Null when the swap manager failed to start — the route reports 503 rather than pretending. */
  lightning: {
    createSubmarineSwap(args: { invoice: string }): Promise<SubmarineQuote>;
    waitForSwapSettlement(swap: SubmarineQuote): Promise<{ preimage?: string }>;
    refundVHTLC(swap: SubmarineQuote): Promise<unknown>;
  } | null;
  /** Funds the swap's lockup address. */
  send: (args: { address: string; amount: number }) => Promise<string>;
  decode: (invoice: string) => { amountSats: number; paymentHash: string };
  caps: { maxSatsPerCall: number; maxSatsPerDay: number };
  outflow: { spentToday(): number; record(sats: number): void; release(sats: number): void };
  rateLimit: { timestamps: number[]; max: number; windowMs: number };
  audit: (entry: PayAuditEntry) => void;
  timeoutMs: number;
  /** When set, replaces the primary API key as this route's credential. */
  payApiKey?: string;
  /** When true, the request Host must be on Railway private networking. */
  requirePrivateHost?: boolean;
}

export const DEFAULT_MAX_SATS_PER_CALL = 2000;
export const DEFAULT_MAX_SATS_PER_DAY = 10000;
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Upper bounds on the caps themselves: a fat-fingered env var must not disable a control. */
export const CAP_CEILING_PER_CALL = 100_000;
export const CAP_CEILING_PER_DAY = 1_000_000;

/**
 * Fee tolerance on the Boltz quote. Submarine fees are ~0.01% plus miner fees, so 2% plus a
 * flat 21 sats is generous for honest operation while still bounding a hostile or malfunctioning
 * quote to a rounding error rather than the balance. Reject rather than clamp: a quote outside
 * this range means the counterparty is not behaving as modelled, and paying a "corrected"
 * amount would just be funding a swap that then fails.
 */
export const FEE_TOLERANCE_MULTIPLIER = 1.02;
export const FEE_TOLERANCE_FLAT_SATS = 21;

/** The most the wallet may be debited for an invoice of `amountSats`. */
export function maxAcceptableDebitSats(amountSats: number): number {
  return Math.floor(amountSats * FEE_TOLERANCE_MULTIPLIER + FEE_TOLERANCE_FLAT_SATS);
}

const PAYMENT_HASH_RE = /^[0-9a-f]{64}$/i;
const PRIVATE_HOST_SUFFIX = '.railway.internal';

/** 8KB. The payload is a bolt11 string and a number; anything larger is not a payment. */
export const MAX_BODY_BYTES = 8 * 1024;

export interface PayConfig {
  maxSatsPerCall: number;
  maxSatsPerDay: number;
  timeoutMs: number;
}

/**
 * Caps and deadline from the environment. Unparseable, non-positive and absurd values all fall
 * back to safe defaults — a typo must not silently widen a spend control, which is the direction
 * `parseInt` alone gets wrong (`"50000000000000000000"` parses fine and is finite).
 */
export function resolveCapsFromEnv(env: Record<string, string | undefined>): PayConfig {
  const bounded = (raw: string | undefined, fallback: number, ceiling: number): number => {
    const parsed = parseInt(raw ?? '', 10);
    // Unset or nonsense falls back to the default; anything real is clamped into range. The
    // clamp is what catches a fat-fingered value, which parses fine and is finite (5e19) and
    // would otherwise be an effectively infinite cap.
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, ceiling);
  };

  const maxSatsPerDay = bounded(env.GOLEM_PAY_MAX_SATS_PER_DAY, DEFAULT_MAX_SATS_PER_DAY, CAP_CEILING_PER_DAY);
  let maxSatsPerCall = bounded(env.GOLEM_PAY_MAX_SATS_PER_CALL, DEFAULT_MAX_SATS_PER_CALL, CAP_CEILING_PER_CALL);

  // A per-call cap above the per-day cap is inert — the day cap would always bite first — and
  // reads as if single payments of that size were sanctioned. Lower it and say so.
  if (maxSatsPerCall > maxSatsPerDay) {
    console.warn(
      `[pay-invoice] per-call cap ${maxSatsPerCall} exceeds per-day cap ${maxSatsPerDay} — ` +
        `lowering per-call to ${maxSatsPerDay}`,
    );
    maxSatsPerCall = maxSatsPerDay;
  }

  return {
    maxSatsPerCall,
    maxSatsPerDay,
    timeoutMs: bounded(env.GOLEM_PAY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 600_000),
  };
}

class PayTimeoutError extends Error {
  constructor(phase: string, ms: number) {
    super(`${phase} exceeded ${ms}ms`);
    this.name = 'PayTimeoutError';
  }
}

/**
 * Race a promise against a deadline WITHOUT disturbing it. The SwapManager keeps monitoring the
 * swap and still auto-refunds after we stop waiting, so the underlying promise is left to run;
 * we only stop blocking the HTTP response on it (red-team HIGH-002).
 */
function withTimeout<T>(work: Promise<T>, ms: number, phase: string): Promise<T> {
  let timer: NodeJS.Timeout;
  // Swallow a late rejection so abandoning the wait cannot raise an unhandled rejection and
  // take down the process that keeps the VTXOs alive.
  work.catch(() => {});
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PayTimeoutError(phase, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * 403, not 429. A 429 tells every mainstream HTTP client "retry shortly", and this condition
 * does not clear until the UTC boundary — so a retrying router would hammer the route for up to
 * a day (red-team MEDIUM-006). Retry-After carries the real answer for clients that read it.
 */
function dailyCapResponse(c: Context, spent: number, needed: number, cap: number) {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  const secondsUntilReset = Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000));

  c.header('Retry-After', String(secondsUntilReset));
  return c.json({
    error: `daily outflow cap reached: ${spent} of ${cap} sats spent today, this payment needs ${needed}`,
    code: 'DAILY_CAP',
  }, 403);
}

export function createPayInvoiceRoute(deps: PayInvoiceDeps): Hono {
  const app = new Hono();

  // Before the handler, so an oversized body is refused rather than buffered into the process
  // that holds the signing key and runs the RefreshAgent (red-team MEDIUM-005).
  app.use(
    '/',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'request body too large', code: 'BODY_TOO_LARGE' }, 413),
    }),
  );

  app.post('/', async (c) => {
    const { lightning, decode, caps, outflow, rateLimit, audit } = deps;

    // Perimeter checks first: an unauthorised caller learns nothing about service state.
    if (deps.requirePrivateHost) {
      // The Host header is what the caller addressed us as; hono/node-server builds c.req.url
      // from it, so the fallback agrees in production and covers request objects built without
      // an explicit header. Strip the port before matching.
      const rawHost = c.req.header('Host') ?? (() => {
        try { return new URL(c.req.url).host; } catch { return ''; }
      })();
      const host = rawHost.split(':')[0].toLowerCase();
      if (!host.endsWith(PRIVATE_HOST_SUFFIX)) {
        return c.json(
          { error: 'pay-invoice is restricted to Railway private networking', code: 'PRIVATE_HOST_REQUIRED' },
          403,
        );
      }
    }

    // A dedicated key means the primary API key is NOT sufficient here. That is the point:
    // the primary key is compromised-at-rest and gates read endpoints all over the app.
    if (deps.payApiKey && !validateBearerToken(c.req.header('Authorization'), deps.payApiKey)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

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
    } catch (err) {
      // bodyLimit only answers through its own onError when it can decide from Content-Length.
      // Without that header it wraps the stream and throws BodyLimitError at read time, i.e.
      // right here — so the size refusal has to be recognised rather than reported as bad JSON.
      // The class is not exported by hono/body-limit, hence the name check.
      if ((err as Error)?.name === 'BodyLimitError') {
        return c.json({ error: 'request body too large', code: 'BODY_TOO_LARGE' }, 413);
      }
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
    const paymentHash = typeof decoded.paymentHash === 'string' ? decoded.paymentHash : '';

    /** One audit line per attempt, with whatever is known by the time we answer. */
    const done = (
      outcome: PayAuditEntry['outcome'],
      code: string | undefined,
      expectedAmountSats?: number,
    ): void => {
      try {
        audit({ ts: Date.now(), paymentHash, amountSats, expectedAmountSats, outcome, code });
      } catch {
        /* auditing must never break settlement; createPayAudit already warns */
      }
    };

    // Also catches NaN: an unmeasurable amount passes every cap comparison below and would be
    // recorded as NaN, poisoning the day's ledger permanently.
    if (typeof amountSats !== 'number' || !Number.isFinite(amountSats) || amountSats <= 0) {
      done('rejected', 'INVALID_AMOUNT');
      return c.json({ error: 'invoice must specify a positive amount — zero-amount invoices are not supported' }, 400);
    }

    // decodeInvoice yields "" when the BOLT11 `p` tag is absent, and the SDK does not guard this
    // on the send path. Without a hash there is nothing to verify the preimage against, so the
    // payment could only ever end in PREIMAGE_MISMATCH — sats out, no credential (MEDIUM-003).
    if (!PAYMENT_HASH_RE.test(paymentHash)) {
      done('rejected', 'INVALID_PAYMENT_HASH');
      return c.json({ error: 'invoice has no valid 64-character hex payment hash', code: 'INVALID_PAYMENT_HASH' }, 400);
    }

    if (maxSats !== undefined && amountSats > maxSats) {
      done('rejected', 'OVER_MAX');
      return c.json({ error: `invoice is ${amountSats} sats, over the requested max of ${maxSats}`, code: 'OVER_MAX' }, 400);
    }

    // Cheap pre-checks on the face value, before any Boltz round trip. The authoritative checks
    // happen again below on the quoted debit; these only avoid creating a swap we would refuse.
    if (amountSats > caps.maxSatsPerCall) {
      done('rejected', 'PER_CALL_CAP');
      return c.json({ error: `invoice is ${amountSats} sats, over the per-call cap of ${caps.maxSatsPerCall}`, code: 'PER_CALL_CAP' }, 400);
    }

    let spent: number;
    try {
      spent = outflow.spentToday();
    } catch {
      // Fail closed: without a trustworthy running total there is no cap (HIGH-004).
      done('rejected', 'LEDGER_UNREADABLE');
      return c.json({ error: 'outflow ledger unreadable — spending disabled', code: 'LEDGER_UNREADABLE' }, 503);
    }

    if (spent + amountSats > caps.maxSatsPerDay) {
      done('rejected', 'DAILY_CAP');
      return dailyCapResponse(c, spent, amountSats, caps.maxSatsPerDay);
    }

    // --- Phase 1: quote the swap. No funds move here. ---

    let quote: SubmarineQuote;
    try {
      quote = await withTimeout(lightning.createSubmarineSwap({ invoice }), deps.timeoutMs, 'swap creation');
    } catch (err) {
      const timedOut = err instanceof PayTimeoutError;
      done('failed', timedOut ? 'PAY_TIMEOUT' : 'SWAP_CREATE_FAILED');
      return c.json({
        error: err instanceof Error ? err.message : String(err),
        code: timedOut ? 'PAY_TIMEOUT' : 'SWAP_CREATE_FAILED',
        paid: false, // nothing was funded
      }, timedOut ? 504 : 502);
    }

    const address = quote.response?.address;
    const expectedAmount = quote.response?.expectedAmount;

    if (typeof address !== 'string' || !address) {
      done('rejected', 'SWAP_QUOTE_REJECTED');
      return c.json({ error: 'swap quote has no lockup address', code: 'SWAP_QUOTE_REJECTED', paid: false }, 502);
    }

    if (typeof expectedAmount !== 'number' || !Number.isSafeInteger(expectedAmount) || expectedAmount <= 0) {
      done('rejected', 'SWAP_QUOTE_REJECTED');
      return c.json({ error: 'swap quote has no usable expectedAmount', code: 'SWAP_QUOTE_REJECTED', paid: false }, 502);
    }

    // The bound that CRITICAL-001 is about. Below the invoice amount is nonsense; far above it
    // is either a hostile response or a fee regime we did not agree to.
    const ceiling = maxAcceptableDebitSats(amountSats);
    if (expectedAmount < amountSats || expectedAmount > ceiling) {
      done('rejected', 'SWAP_QUOTE_REJECTED', expectedAmount);
      return c.json({
        error: `swap quote of ${expectedAmount} sats is outside the accepted range for a ${amountSats} sat invoice (max ${ceiling})`,
        code: 'SWAP_QUOTE_REJECTED',
        paid: false,
      }, 502);
    }

    // Re-run the caps against the REAL debit. This is the authoritative check.
    if (expectedAmount > caps.maxSatsPerCall) {
      done('rejected', 'PER_CALL_CAP', expectedAmount);
      return c.json({ error: `swap would debit ${expectedAmount} sats, over the per-call cap of ${caps.maxSatsPerCall}`, code: 'PER_CALL_CAP' }, 400);
    }

    // Re-read: the quote round trip is an `await`, so another request may have reserved since.
    // From here to `record()` there is no `await` — that is what makes check-and-reserve atomic.
    try {
      spent = outflow.spentToday();
    } catch {
      done('rejected', 'LEDGER_UNREADABLE', expectedAmount);
      return c.json({ error: 'outflow ledger unreadable — spending disabled', code: 'LEDGER_UNREADABLE' }, 503);
    }

    if (spent + expectedAmount > caps.maxSatsPerDay) {
      done('rejected', 'DAILY_CAP', expectedAmount);
      return dailyCapResponse(c, spent, expectedAmount, caps.maxSatsPerDay);
    }

    // Reserve the real debit before funding. A throw here means the ledger cannot remember the
    // spend, which is a reason not to spend: it propagates and nothing is funded.
    outflow.record(expectedAmount);

    /** Hand headroom back. Only ever called where the failure is provably clean. */
    const releaseReservation = (): void => {
      try {
        outflow.release(expectedAmount);
      } catch (err) {
        console.warn(`[pay-invoice] could not release reservation: ${err instanceof Error ? err.message : err}`);
      }
    };

    // --- Phase 2: fund the swap. ---

    const startedAt = Date.now();
    let txid: string;
    try {
      txid = await withTimeout(deps.send({ address, amount: expectedAmount }), deps.timeoutMs, 'swap funding');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // The Ark SDK throws a bare Error("Insufficient funds") before broadcasting anything, so
      // this specific failure is provably pre-broadcast and the headroom can go back. Matching
      // on a message is fragile, so it fails safe: anything unrecognised keeps the reservation.
      if (message === 'Insufficient funds') {
        releaseReservation();
        done('failed', 'INSUFFICIENT_FUNDS', expectedAmount);
        return c.json({ error: message, code: 'INSUFFICIENT_FUNDS', paid: false }, 502);
      }

      const timedOut = err instanceof PayTimeoutError;
      done('failed', timedOut ? 'PAY_TIMEOUT' : 'PAY_AMBIGUOUS', expectedAmount);
      return c.json({
        error: message,
        code: timedOut ? 'PAY_TIMEOUT' : 'PAY_AMBIGUOUS',
        paid: true, // the send may have broadcast before failing — do not retry blindly
      }, timedOut ? 504 : 502);
    }

    // --- Phase 3: wait for settlement and the preimage. ---

    let preimage: string;
    try {
      const settled = await withTimeout(lightning.waitForSwapSettlement(quote), deps.timeoutMs, 'settlement');
      preimage = typeof settled?.preimage === 'string' ? settled.preimage : '';
    } catch (err) {
      // Replicates what sendLightningPayment does on a refundable failure. The SwapManager
      // would also act on it, but this path must not depend on that.
      let refunded = false;
      if ((err as { isRefundable?: boolean })?.isRefundable) {
        try {
          await lightning.refundVHTLC(quote);
          refunded = true;
        } catch (refundErr) {
          console.warn(`[pay-invoice] refund attempt failed: ${refundErr instanceof Error ? refundErr.message : refundErr}`);
        }
      }

      if (err instanceof PayTimeoutError) {
        done('failed', 'PAY_TIMEOUT', expectedAmount);
        return c.json({
          error: `payment did not settle within ${deps.timeoutMs}ms — the swap is still being monitored`,
          code: 'PAY_TIMEOUT',
          paid: true,
        }, 504);
      }

      // A confirmed refund is the one settlement failure that provably returned the sats.
      if (err instanceof TransactionFailedError && refunded) {
        releaseReservation();
        done('failed', 'PAY_FAILED', expectedAmount);
        return c.json({ error: err.message, code: 'PAY_FAILED', paid: false }, 502);
      }

      // Reserved for a future SDK that actually throws it: in boltz-swap 0.3.56 PreimageFetchError
      // is exported but never constructed, so the real "settled, preimage GET failed" case lands
      // in PAY_AMBIGUOUS below — which carries the same paid disposition, by design.
      if (err instanceof PreimageFetchError) {
        done('failed', 'PREIMAGE_UNAVAILABLE', expectedAmount);
        return c.json({ error: err.message, code: 'PREIMAGE_UNAVAILABLE', paid: true }, 502);
      }

      done('failed', 'PAY_AMBIGUOUS', expectedAmount);
      return c.json({
        error: err instanceof Error ? err.message : String(err),
        code: 'PAY_AMBIGUOUS',
        paid: true, // the invoice may have settled — only paid:false is safe to retry
      }, 502);
    }

    const durationMs = Date.now() - startedAt;

    // The preimage is the only proof the invoice settled, and it is what the caller presents as
    // an L402 token. Verify it against the hash we decoded ourselves, not the provider's word.
    const hash = preimage ? createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') : '';
    if (!preimage || hash !== paymentHash.toLowerCase()) {
      done('failed', 'PREIMAGE_MISMATCH', expectedAmount);
      return c.json({
        error: 'preimage does not match payment hash',
        code: 'PREIMAGE_MISMATCH',
        paid: true, // sats have left — the caller has to reconcile, not retry
      }, 502);
    }

    done('paid', undefined, expectedAmount);
    return c.json({ preimage, amountSats, debitedSats: expectedAmount, txid, durationMs });
  });

  return app;
}
