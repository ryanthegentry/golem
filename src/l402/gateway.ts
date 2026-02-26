/**
 * L402 Gateway — Hono middleware that gates HTTP routes behind Lightning payments.
 *
 * Unpaid requests get a 402 with a V2 binary macaroon + invoice.
 * Paid requests include "Authorization: L402 <macaroon>:<preimage>" and pass through.
 *
 * Security: per-macaroon root keys via RootKeyStore, time-before caveats,
 * constant-time preimage verification, IP-based rate limiting.
 */

import type { MiddlewareHandler } from 'hono';
import type { ArkadeLightning } from '@arkade-os/boltz-swap';
import {
  mintL402Macaroon,
  verifyL402Token,
  parseL402Header,
  formatL402Challenge,
  MemoryRootKeyStore,
  type RootKeyStore,
} from './macaroon.js';

export interface GatewayConfig {
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
}

export interface GatewayStats {
  totalRequests: number;
  paidRequests: number;
  challengesIssued: number;
  totalSatsEarned: number;
  rateLimited: number;
}

export interface L402Gateway {
  middleware: MiddlewareHandler;
  stats: GatewayStats;
  rootKeyStore: RootKeyStore;
}

/**
 * Simple sliding-window rate limiter per IP.
 * Tracks timestamps of recent 402 challenges per source IP.
 */
class RateLimiter {
  private windows = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs = 60_000;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Returns true if the request should be rate-limited (rejected). */
  check(ip: string): boolean {
    if (this.limit <= 0) return false;

    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(ip, timestamps);
    }

    // Prune old entries
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.limit) {
      return true; // Rate limited
    }

    timestamps.push(now);
    return false;
  }
}

/**
 * Creates an L402 gateway middleware.
 *
 * Flow:
 * 1. Free path? → pass through
 * 2. Has valid L402 Authorization header? → verify → pass through
 * 3. Rate limit check on 402 challenges
 * 4. Otherwise → create invoice, mint macaroon → 402 challenge
 */
export function createL402Gateway(
  lightning: ArkadeLightning,
  config: GatewayConfig,
): L402Gateway {
  const rootKeyStore = config.rootKeyStore ?? new MemoryRootKeyStore();
  const freePaths = new Set(config.freePaths ?? []);
  const caveats = config.caveats ?? [];
  const priceSats = config.priceSats;
  const ttlSeconds = config.ttlSeconds ?? 300;
  const description = config.description ?? `Payment required: ${priceSats} sats`;
  const rateLimiter = new RateLimiter(config.rateLimitPerMinute ?? 30);

  const stats: GatewayStats = {
    totalRequests: 0,
    paidRequests: 0,
    challengesIssued: 0,
    totalSatsEarned: 0,
    rateLimited: 0,
  };

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
          stats.paidRequests++;
          stats.totalSatsEarned += priceSats;
          console.log(`[l402] Verified payment for ${reqPath} (hash: ${result.paymentHash?.slice(0, 16)}...)`);
          return next();
        }
        console.log(`[l402] Invalid L402 token for ${reqPath}: ${result.error}`);
      }
    }

    // Rate limit 402 challenge issuance
    const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || c.req.header('x-real-ip')
      || 'unknown';
    if (rateLimiter.check(clientIp)) {
      stats.rateLimited++;
      console.log(`[l402] Rate limited ${clientIp} for ${reqPath}`);
      return c.json({ error: 'Too many requests' }, 429);
    }

    // Issue 402 challenge
    try {
      const invoiceResult = await lightning.createLightningInvoice({ amount: priceSats });
      const { macaroonBase64, paymentHash } = mintL402Macaroon(rootKeyStore, {
        paymentHash: invoiceResult.paymentHash,
        location: 'golem',
        ttlSeconds,
        caveats,
      });
      const challenge = formatL402Challenge(macaroonBase64, invoiceResult.invoice);

      stats.challengesIssued++;
      console.log(`[l402] Issued 402 challenge for ${reqPath} (${priceSats} sats)`);

      return c.json({
        error: 'Payment Required',
        description,
        price: priceSats,
        invoice: invoiceResult.invoice,
        macaroon: macaroonBase64,
        paymentHash,
      }, 402, {
        'WWW-Authenticate': challenge,
      });
    } catch (err) {
      console.error('[l402] Failed to create invoice:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Failed to create payment challenge' }, 500);
    }
  };

  return { middleware, stats, rootKeyStore };
}
