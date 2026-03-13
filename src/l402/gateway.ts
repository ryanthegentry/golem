/**
 * L402 Gateway — Hono middleware that gates HTTP routes behind Lightning payments.
 *
 * Dual-mode: accepts both Lightning (via Boltz reverse swaps) and Ark-native OOR payments.
 * Unpaid requests get a 402 with a V2 binary macaroon + invoice (+ optional Ark payment option).
 * Paid requests include "Authorization: L402 <macaroon>:<preimage>" and pass through.
 *
 * Security: per-macaroon root keys via RootKeyStore, time-before caveats,
 * constant-time preimage verification, IP-based rate limiting.
 */

import { randomBytes, createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { ArkadeSwaps } from '@arkade-os/boltz-swap';
import {
  mintL402Macaroon,
  verifyL402Token,
  parseL402Header,
  formatL402Challenge,
  MemoryRootKeyStore,
  type RootKeyStore,
} from './macaroon.js';
import { InvoiceLimiter } from './invoice-limiter.js';

interface PendingArkPayment {
  paymentId: string;
  paymentHash: string;
  preimage: string;
  macaroonBase64: string;
  amount: number;
  createdAt: number;
  expiresAt: number;
  fulfilled: boolean;
}

/** Narrow wallet interface — only what the gateway needs for Ark OOR detection. */
interface ArkWalletNotifier {
  notifyIncomingFunds(callback: (funds: IncomingFundsEvent) => void): Promise<() => void>;
}

/** Incoming funds event from the Ark SDK's notifyIncomingFunds callback. */
interface IncomingFundsEvent {
  type: 'utxo' | 'vtxo';
  newVtxos?: Array<{ value: number; [key: string]: unknown }>;
  spentVtxos?: Array<{ value: number; [key: string]: unknown }>;
  coins?: Array<{ value: number; [key: string]: unknown }>;
}

interface GatewayConfig {
  /** Price per request in satoshis */
  priceSats: number;
  /** Root key store for per-macaroon keys. Defaults to MemoryRootKeyStore. */
  rootKeyStore?: RootKeyStore;
  /** Optional description shown in 402 response */
  description?: string;
  /** Paths that are free (no payment required), e.g. ["/health", "/docs"] */
  freePaths?: string[];
  /** Optional macaroon caveats to add to every token */
  caveats?: string[];
  /** TTL for macaroons in seconds (default: 300). Added as time-before caveat. */
  ttlSeconds?: number;
  /** Max 402 challenges per IP per minute (default: 30, 0 = disabled) */
  rateLimitPerMinute?: number;
  /** Ark address for OOR payments. Enables dual-mode if set. */
  arkAddress?: string;
  /** Wallet for Ark OOR VTXO detection. Required if arkAddress is set. */
  wallet?: ArkWalletNotifier;
  /** Called after a successful L402 payment verification. */
  onPayment?: (rail: 'lightning' | 'ark', sats: number, paymentHash: string) => void;
}

interface GatewayStats {
  totalRequests: number;
  paidRequests: number;
  challengesIssued: number;
  totalSatsEarned: number;
  rateLimited: number;
  lightningPaidRequests: number;
  lightningEarned: number;
  arkPaidRequests: number;
  arkEarned: number;
  arkPendingPayments: number;
}

interface L402Gateway {
  middleware: MiddlewareHandler;
  preimageHandler: MiddlewareHandler;
  getStats(): Readonly<GatewayStats>;
  dispose(): void;
  /** Exposed only for tests — do not use in production code. */
  _testInternals(): { pendingPayments: Map<string, PendingArkPayment>; rootKeyStore: RootKeyStore };
}

/**
 * Simple sliding-window rate limiter per IP.
 * Tracks timestamps of recent 402 challenges per source IP.
 */
class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs = 60_000;
  private readonly exemptPaths = new Set<string>();
  private lastCleanup = Date.now();

  constructor(limit: number, exemptPaths?: string[]) {
    this.limit = limit;
    if (exemptPaths) {
      for (const p of exemptPaths) this.exemptPaths.add(p);
    }
  }

  /** Returns true if the request should be rate-limited (rejected). */
  check(ip: string, path?: string): boolean {
    if (this.limit <= 0) return false;
    if (path && this.exemptPaths.has(path)) return false;

    const now = Date.now();

    // Periodic eviction of stale entries (every 5 minutes)
    if (now - this.lastCleanup > 300_000) {
      for (const [key, window] of this.windows) {
        if (window.resetAt <= now) this.windows.delete(key);
      }
      this.lastCleanup = now;
    }

    const window = this.windows.get(ip);

    if (!window || window.resetAt <= now) {
      // New window — first request
      this.windows.set(ip, { count: 1, resetAt: now + this.windowMs });
      return false;
    }

    if (window.count >= this.limit) {
      return true; // Rate limited
    }

    window.count++;
    return false;
  }
}

/**
 * Creates an L402 gateway middleware with dual-mode payment support.
 *
 * Flow:
 * 1. Free path? → pass through
 * 2. Has valid L402 Authorization header? → verify → pass through
 * 3. Rate limit check on 402 challenges
 * 4. Otherwise → create Lightning invoice + optional Ark payment option → 402 challenge
 *
 * Ark OOR payments use gateway-generated preimages. The consumer pays via
 * wallet.sendBitcoin(), gateway detects the VTXO, and reveals the preimage
 * at GET /l402/preimage?payment_id=X. The consumer then uses the standard
 * L402 Authorization header — identical to Lightning.
 */
export function createL402Gateway(
  lightning: ArkadeSwaps,
  config: GatewayConfig,
): L402Gateway {
  const rootKeyStore = config.rootKeyStore ?? new MemoryRootKeyStore();
  const freePaths = new Set(config.freePaths ?? []);
  const caveats = config.caveats ?? [];
  const priceSats = config.priceSats;
  const ttlSeconds = config.ttlSeconds ?? 300;
  const description = config.description ?? `Payment required: ${priceSats} sats`;
  const arkEnabled = !!(config.arkAddress && config.wallet);
  const arkAddress = config.arkAddress;

  // Exempt /l402/preimage from rate limiting — consumers poll it every 500ms
  const rateLimiter = new RateLimiter(config.rateLimitPerMinute ?? 30, ['/l402/preimage']);

  // Cap pending unpaid invoices to prevent resource exhaustion
  const invoiceLimiter = new InvoiceLimiter();

  const pendingPayments = new Map<string, PendingArkPayment>();

  const stats: GatewayStats = {
    totalRequests: 0,
    paidRequests: 0,
    challengesIssued: 0,
    totalSatsEarned: 0,
    rateLimited: 0,
    lightningPaidRequests: 0,
    lightningEarned: 0,
    arkPaidRequests: 0,
    arkEarned: 0,
    arkPendingPayments: 0,
  };

  /**
   * Match an incoming VTXO amount against pending Ark payments (FIFO order).
   * Each 402 challenge adds a random 1-99 sat suffix to the Ark amount, so
   * exact-amount matching disambiguates concurrent payments. Extremely high
   * concurrency could still collide (known limitation).
   */
  function matchIncomingVtxo(amountSats: number): PendingArkPayment | null {
    const now = Date.now();
    for (const pending of pendingPayments.values()) {
      if (!pending.fulfilled && pending.expiresAt > now && pending.amount === amountSats) {
        pending.fulfilled = true;
        stats.arkPendingPayments = [...pendingPayments.values()].filter(p => !p.fulfilled && p.expiresAt > now).length;
        return pending;
      }
    }
    return null;
  }

  // Start VTXO listener if Ark is enabled (with retry on failure)
  let stopVtxoListener: (() => void) | null = null;
  if (arkEnabled && config.wallet) {
    const wallet = config.wallet;
    const startListener = async (attempt = 1): Promise<void> => {
      try {
        stopVtxoListener = await wallet.notifyIncomingFunds((funds) => {
          if (funds.type === 'vtxo' && funds.newVtxos) {
            for (const vtxo of funds.newVtxos) {
              if (typeof vtxo.value === 'number' && vtxo.value > 0) {
                matchIncomingVtxo(vtxo.value);
              }
            }
          }
        });
      } catch (err) {
        console.error(`[l402:ark] VTXO listener error (attempt ${attempt}):`, err instanceof Error ? err.message : err);
        if (attempt < 3) {
          setTimeout(() => void startListener(attempt + 1), 5000 * attempt);
        } else {
          console.error('[l402:ark] VTXO listener failed after 3 attempts — Ark OOR payments disabled');
        }
      }
    };
    void startListener();
  }

  // Cleanup expired pending payments every 10s
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, pending] of pendingPayments) {
      if (pending.expiresAt <= now) {
        pendingPayments.delete(id);
      }
    }
    stats.arkPendingPayments = [...pendingPayments.values()].filter(p => !p.fulfilled && p.expiresAt > now).length;
  }, 10_000);

  const middleware: MiddlewareHandler = async (c, next) => {
    stats.totalRequests++;

    // Free paths pass through
    const reqPath = new URL(c.req.url).pathname;
    if (freePaths.has(reqPath)) {
      return next();
    }

    // Check for L402 Authorization header
    const authHeader = c.req.header('Authorization');
    if (authHeader) {
      const parsed = parseL402Header(authHeader);
      if (parsed) {
        const result = verifyL402Token(rootKeyStore, parsed.macaroon, parsed.preimage);
        if (result.valid) {
          // Remove from pending invoice limiter
          if (result.paymentHash) invoiceLimiter.markPaid(result.paymentHash);

          stats.paidRequests++;
          stats.totalSatsEarned += priceSats;

          // Track per-rail stats: check if paymentHash matches a pending Ark payment
          const arkPayment = result.paymentHash
            ? [...pendingPayments.values()].find(p => p.paymentHash === result.paymentHash)
            : null;
          const rail: 'lightning' | 'ark' = arkPayment ? 'ark' : 'lightning';
          if (arkPayment) {
            stats.arkPaidRequests++;
            stats.arkEarned += priceSats;
          } else {
            stats.lightningPaidRequests++;
            stats.lightningEarned += priceSats;
          }

          // Notify payment callback (for Telegram bot, etc.)
          if (config.onPayment && result.paymentHash) {
            try { config.onPayment(rail, priceSats, result.paymentHash); } catch { /* never crash on callback */ }
          }

          return next();
        }
      }
    }

    // Rate limit 402 challenge issuance
    // Only trust x-forwarded-for / x-real-ip when GOLEM_TRUSTED_PROXY is set,
    // otherwise use the socket's remote address to prevent IP spoofing.
    let clientIp = 'unknown';
    try {
      const info = getConnInfo(c);
      clientIp = info.remote.address ?? 'unknown';
    } catch { /* unit tests run without a real socket */ }
    if (process.env.GOLEM_TRUSTED_PROXY) {
      clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        || c.req.header('x-real-ip')
        || clientIp;
    }
    if (rateLimiter.check(clientIp, reqPath)) {
      stats.rateLimited++;
      return c.json({ error: 'Too many requests' }, 429);
    }

    // Issue 402 challenge — reuse oldest pending invoice if at limit
    const existing = invoiceLimiter.getOrNull();
    if (existing) {
      stats.challengesIssued++;
      const challenge = formatL402Challenge(existing.macaroonBase64, existing.invoice);
      return c.json({
        error: 'Payment Required',
        description,
        price: priceSats,
        invoice: existing.invoice,
        macaroon: existing.macaroonBase64,
        paymentHash: existing.paymentHash,
      }, 402, { 'WWW-Authenticate': challenge });
    }

    try {
      const invoiceResult = await lightning.createLightningInvoice({ amount: priceSats });
      const { macaroonBase64, paymentHash } = mintL402Macaroon(rootKeyStore, {
        paymentHash: invoiceResult.paymentHash,
        location: 'golem',
        ttlSeconds,
        caveats,
      });
      const challenge = formatL402Challenge(macaroonBase64, invoiceResult.invoice);

      // Track pending invoice for rate limiting
      invoiceLimiter.add({
        invoice: invoiceResult.invoice,
        paymentHash,
        macaroonBase64,
        priceSats,
        createdAt: Date.now(),
      });

      stats.challengesIssued++;

      // Build response body
      const responseBody: Record<string, unknown> = {
        error: 'Payment Required',
        description,
        price: priceSats,
        invoice: invoiceResult.invoice,
        macaroon: macaroonBase64,
        paymentHash,
      };

      // Add Ark payment option if enabled
      if (arkEnabled && arkAddress) {
        const arkPreimage = randomBytes(32).toString('hex');
        const arkPaymentHash = createHash('sha256')
          .update(Buffer.from(arkPreimage, 'hex'))
          .digest('hex');
        const paymentId = randomBytes(16).toString('hex');

        const arkMac = mintL402Macaroon(rootKeyStore, {
          paymentHash: arkPaymentHash,
          location: 'golem',
          ttlSeconds,
          caveats,
        });

        // Random 1-9999 sat suffix to disambiguate concurrent payments.
        // Birthday collision probability <1% for 50 concurrent payments.
        // Production: replace with OP_RETURN payment ID or unique VTXO descriptor matching.
        const arkAmount = priceSats + (randomBytes(2).readUInt16BE(0) % 9999) + 1;

        const pending: PendingArkPayment = {
          paymentId,
          paymentHash: arkPaymentHash,
          preimage: arkPreimage,
          macaroonBase64: arkMac.macaroonBase64,
          amount: arkAmount,
          createdAt: Date.now(),
          expiresAt: Date.now() + ttlSeconds * 1000,
          fulfilled: false,
        };
        pendingPayments.set(paymentId, pending);
        stats.arkPendingPayments++;

        responseBody.ark_payment = {
          address: arkAddress,
          amount: arkAmount,
          payment_id: paymentId,
          macaroon: arkMac.macaroonBase64,
        };

      }

      return c.json(responseBody, 402, {
        // WWW-Authenticate stays Lightning-only for backward compat with lnget
        'WWW-Authenticate': challenge,
      });
    } catch (err) {
      console.error('[l402] Failed to create invoice:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Failed to create payment challenge' }, 500);
    }
  };

  /**
   * Preimage handler — GET /l402/preimage?payment_id=X
   * Returns the preimage after VTXO detection confirms Ark payment.
   */
  const preimageHandler: MiddlewareHandler = async (c) => {
    const paymentId = c.req.query('payment_id');
    if (!paymentId) {
      return c.json({ error: 'Missing payment_id parameter' }, 400);
    }

    const pending = pendingPayments.get(paymentId);
    if (!pending || pending.expiresAt <= Date.now()) {
      return c.json({ error: 'Unknown or expired payment' }, 404);
    }

    if (!pending.fulfilled) {
      return c.json({ status: 'pending', message: 'Waiting for VTXO detection' }, 202);
    }

    return c.json({
      preimage: pending.preimage,
      macaroon: pending.macaroonBase64,
    }, 200);
  };

  function dispose() {
    if (stopVtxoListener) {
      stopVtxoListener();
      stopVtxoListener = null;
    }
    clearInterval(cleanupInterval);
  }

  return {
    middleware,
    preimageHandler,
    getStats: (): Readonly<GatewayStats> => ({ ...stats }),
    dispose,
    _testInternals: () => ({ pendingPayments, rootKeyStore }),
  };
}
