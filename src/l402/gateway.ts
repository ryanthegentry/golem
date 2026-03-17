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
import type { ResponseCache } from './response-cache.js';

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
  /** Response cache for cache-and-resell. */
  cache?: ResponseCache;
  /** Upstream URL for proxying on cache miss (required if cache is set). */
  upstreamUrl?: string;
  /** Cache price as percentage of full price (1-100). Default: 20. */
  cachePricePercent?: number;
  /** Default TTL for cached responses in seconds. Default: 3600. */
  cacheDefaultTtl?: number;
  /** Required HTTP method for upstream (e.g. "POST"). Null = any method allowed. */
  upstreamMethod?: string | null;
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
  cacheHits: number;
  cacheMisses: number;
  cacheSatsEarned: number;
}

interface L402Gateway {
  middleware: MiddlewareHandler;
  preimageHandler: MiddlewareHandler;
  getStats(): Readonly<GatewayStats>;
  dispose(): void;
  /** Exposed only for tests — do not use in production code. */
  _testInternals(): { pendingPayments: Map<string, PendingArkPayment>; rootKeyStore: RootKeyStore; boltzCircuitBreaker: { isOpen(): boolean; record(): void; reset(): void } };
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

  // Cache-and-resell config
  const responseCache = config.cache ?? null;
  const upstreamUrl = config.upstreamUrl ?? null;
  const cachePricePercent = config.cachePricePercent ?? 20;
  const cacheDefaultTtl = config.cacheDefaultTtl ?? 3600;
  const cacheEnabled = !!(responseCache && upstreamUrl);
  const upstreamMethod = config.upstreamMethod?.toUpperCase() ?? null;

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
    cacheHits: 0,
    cacheMisses: 0,
    cacheSatsEarned: 0,
  };

  // Boltz circuit breaker: after 5 consecutive failures within 60s, skip for 30s
  const boltzCircuitBreaker = {
    failures: [] as number[],
    openUntil: 0,
    maxFailures: 5,
    windowMs: 60_000,
    cooldownMs: 30_000,

    record(): void {
      const now = Date.now();
      this.failures.push(now);
      // Keep only failures within the window
      this.failures = this.failures.filter(t => now - t < this.windowMs);
      if (this.failures.length >= this.maxFailures) {
        this.openUntil = now + this.cooldownMs;
        console.warn(`[gateway] Boltz circuit breaker OPEN — skipping for ${this.cooldownMs / 1000}s after ${this.maxFailures} failures`);
      }
    },

    isOpen(): boolean {
      if (Date.now() >= this.openUntil) {
        if (this.openUntil > 0) {
          this.openUntil = 0;
          this.failures = [];
        }
        return false;
      }
      return true;
    },

    reset(): void {
      this.failures = [];
      this.openUntil = 0;
    },
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

  // Start VTXO listener if Ark is enabled (with exponential backoff retry)
  let stopVtxoListener: (() => void) | null = null;
  if (arkEnabled && config.wallet) {
    const wallet = config.wallet;
    const MAX_BACKOFF_MS = 60_000; // 60s ceiling
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
        if (attempt > 1) {
          console.log(`[l402:ark] VTXO listener reconnected after ${attempt} attempts`);
        }
      } catch (err) {
        // Exponential backoff: 5s, 10s, 20s, 40s, 60s, 60s, ...
        const backoffMs = Math.min(5000 * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
        console.error(`[l402:ark] VTXO listener error (attempt ${attempt}, retry in ${Math.round(backoffMs / 1000)}s):`, err instanceof Error ? err.message : err);
        setTimeout(() => void startListener(attempt + 1), backoffMs);
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

  // Headers forwarded when proxying upstream (cache miss)
  const FORWARDED_HEADERS = ['content-type', 'accept', 'user-agent'] as const;

  /** Proxy a request to upstream and return the response. Used for cache-miss proxying. */
  async function proxyToUpstream(
    method: string,
    targetUrl: string,
    reqHeaders: (name: string) => string | undefined,
    body: string | undefined,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const headers = new Headers();
    for (const key of FORWARDED_HEADERS) {
      const val = reqHeaders(key);
      if (val) headers.set(key, val);
    }

    const res = await fetch(targetUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      signal: AbortSignal.timeout(60_000),
    });

    const resBody = await res.text();
    const contentType = res.headers.get('content-type') || 'application/json';

    return {
      status: res.status,
      headers: { 'Content-Type': contentType },
      body: resBody,
    };
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    stats.totalRequests++;

    // Free paths pass through
    const reqPath = new URL(c.req.url).pathname;
    if (freePaths.has(reqPath)) {
      return next();
    }

    // --- Cache lookup (before 402 challenge, to set correct price) ---
    const reqUrl = new URL(c.req.url);
    // Buffer request body for cache key + potential proxy reuse (stream can only be read once)
    const reqBody = ['GET', 'HEAD'].includes(c.req.method) ? '' : await c.req.text();
    let cacheKey: string | null = null;
    let cacheHit = false;

    if (cacheEnabled && responseCache) {
      const fullUpstreamUrl = `${upstreamUrl}${reqUrl.pathname}${reqUrl.search}`;
      cacheKey = responseCache.computeKey(fullUpstreamUrl, c.req.method, reqBody);
      const cached = responseCache.get(cacheKey);
      if (cached) {
        cacheHit = true;
      }
    }

    // Determine effective price: cache hit → reduced price, miss → full price
    const effectivePrice = cacheHit
      ? Math.max(1, Math.ceil(priceSats * cachePricePercent / 100))
      : priceSats;

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
          stats.totalSatsEarned += effectivePrice;

          // Track per-rail stats: check if paymentHash matches a pending Ark payment
          const arkPayment = result.paymentHash
            ? [...pendingPayments.values()].find(p => p.paymentHash === result.paymentHash)
            : null;
          const rail: 'lightning' | 'ark' = arkPayment ? 'ark' : 'lightning';
          if (arkPayment) {
            stats.arkPaidRequests++;
            stats.arkEarned += effectivePrice;
          } else {
            stats.lightningPaidRequests++;
            stats.lightningEarned += effectivePrice;
          }

          // Notify payment callback (for Telegram bot, etc.)
          if (config.onPayment && result.paymentHash) {
            try { config.onPayment(rail, effectivePrice, result.paymentHash); } catch { /* never crash on callback */ }
          }

          // --- Post-auth method validation ---
          // If upstream requires a specific method, reject mismatches with 405.
          // The L402 token remains valid — don't waste it.
          if (upstreamMethod && c.req.method.toUpperCase() !== upstreamMethod) {
            return c.json({
              error: 'Method Not Allowed',
              allowed_methods: [upstreamMethod],
              hint: `This endpoint requires ${upstreamMethod} with a request body. Your L402 token is still valid.`,
            }, 405);
          }

          // --- Cache-and-resell: serve from cache or proxy-and-cache ---
          if (cacheEnabled && responseCache && upstreamUrl && cacheKey) {
            // Re-check cache — entry may have expired between challenge and payment
            // (TTL race condition). If it expired, honor the payment and proxy upstream.
            // The operator eats the price difference on this rare edge case
            // (1-hour default TTL vs seconds-to-pay window). NEVER issue a second 402.
            const cached = responseCache.get(cacheKey);

            if (cached) {
              // Cache hit — serve directly, record earnings
              stats.cacheHits++;
              stats.cacheSatsEarned += effectivePrice;
              responseCache.recordEarnings(cacheKey, effectivePrice);

              // Node.js Buffer is a Uint8Array subclass and valid as BodyInit at runtime.
              // TypeScript 5.7+ @types/node incorrectly excludes it from the BodyInit union.
              return new Response(cached.responseBody as any, {
                status: cached.responseStatus,
                headers: {
                  ...cached.responseHeaders,
                  'X-Golem-Cache': 'HIT',
                },
              });
            }

            // Cache miss (or TTL race) — proxy upstream and cache the response
            stats.cacheMisses++;
            try {
              const fullTarget = `${upstreamUrl}${reqUrl.pathname}${reqUrl.search}`;
              const upstream = await proxyToUpstream(
                c.req.method,
                fullTarget,
                (name: string) => c.req.header(name),
                reqBody || undefined,
              );

              // Only cache successful (2xx), non-streaming responses
              const isStreaming = (upstream.headers['Content-Type'] || '').includes('text/event-stream');
              if (upstream.status >= 200 && upstream.status < 300 && !isStreaming) {
                responseCache.put(cacheKey, {
                  upstreamUrl: fullTarget,
                  requestMethod: c.req.method,
                  requestBodyHash: createHash('sha256').update(reqBody).digest('hex'),
                  responseStatus: upstream.status,
                  responseHeaders: upstream.headers,
                  responseBody: Buffer.from(upstream.body),
                }, cacheDefaultTtl);
              }

              return new Response(upstream.body, {
                status: upstream.status,
                headers: {
                  ...upstream.headers,
                  'X-Golem-Cache': 'MISS',
                },
              });
            } catch (err) {
              if (err instanceof DOMException && err.name === 'TimeoutError') {
                return c.json({ error: 'Upstream timeout' }, 504);
              }
              console.error('[l402:cache] Upstream proxy error:', err instanceof Error ? err.message : err);
              return c.json({ error: 'Upstream unavailable' }, 502);
            }
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
      const challengeBody: Record<string, unknown> = {
        error: 'Payment Required',
        description,
        price: effectivePrice,
        invoice: existing.invoice,
        macaroon: existing.macaroonBase64,
        paymentHash: existing.paymentHash,
      };
      if (upstreamMethod) challengeBody.method = upstreamMethod;
      const challengeHeaders: Record<string, string> = { 'WWW-Authenticate': challenge };
      if (cacheEnabled) {
        challengeHeaders['X-Golem-Cache'] = cacheHit ? 'HIT' : 'MISS';
        if (cacheHit) challengeBody.fullPrice = priceSats;
      }
      return c.json(challengeBody, 402, challengeHeaders);
    }

    // Circuit breaker: if Boltz is known-down, fail fast with 503
    if (boltzCircuitBreaker.isOpen()) {
      return c.json(
        { error: 'Payment service temporarily unavailable', retry_after: 30 },
        503,
        { 'Retry-After': '30' },
      );
    }

    // Retry Boltz invoice creation: 3 attempts, exponential backoff (500ms, 1s, 2s)
    let invoiceResult: { invoice: string; paymentHash: string } | null = null;
    let lastError: unknown = null;
    const maxRetries = 3;
    const backoffMs = [500, 1000, 2000];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        invoiceResult = await lightning.createLightningInvoice({ amount: effectivePrice });
        boltzCircuitBreaker.reset();
        break;
      } catch (err) {
        lastError = err;
        console.warn(`[gateway] Boltz retry ${attempt}/${maxRetries}: ${err instanceof Error ? err.message : err}`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, backoffMs[attempt - 1]));
        }
      }
    }

    if (!invoiceResult) {
      boltzCircuitBreaker.record();
      console.error('[l402] Boltz invoice creation failed after retries:', lastError instanceof Error ? lastError.message : lastError);
      return c.json(
        { error: 'Payment service temporarily unavailable', retry_after: 30 },
        503,
        { 'Retry-After': '30' },
      );
    }

    try {
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
        priceSats: effectivePrice,
        createdAt: Date.now(),
      });

      stats.challengesIssued++;

      // Build response body
      const responseBody: Record<string, unknown> = {
        error: 'Payment Required',
        description,
        price: effectivePrice,
        invoice: invoiceResult.invoice,
        macaroon: macaroonBase64,
        paymentHash,
      };

      if (upstreamMethod) responseBody.method = upstreamMethod;

      const responseHeaders: Record<string, string> = {
        // WWW-Authenticate stays Lightning-only for backward compat with lnget
        'WWW-Authenticate': challenge,
      };

      if (cacheEnabled) {
        responseHeaders['X-Golem-Cache'] = cacheHit ? 'HIT' : 'MISS';
        if (cacheHit) responseBody.fullPrice = priceSats;
      }

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
        const arkAmount = effectivePrice + (randomBytes(2).readUInt16BE(0) % 9999) + 1;

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

      return c.json(responseBody, 402, responseHeaders);
    } catch (err) {
      console.error('[l402] Failed to create payment challenge:', err instanceof Error ? err.message : err);
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
    _testInternals: () => ({ pendingPayments, rootKeyStore, boltzCircuitBreaker }),
  };
}
