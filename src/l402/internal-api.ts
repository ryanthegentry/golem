/**
 * L402 Internal API — contract for 402index integration.
 *
 * POST /l402/challenge — create a payment challenge (macaroon + invoice)
 * POST /l402/verify — verify an L402 authorization token
 * GET /l402/status — health + metrics
 *
 * Binds to 127.0.0.1 only in development, configurable port (default 8402).
 * In production (Railway), bind to the internal network only.
 */

import { Hono } from 'hono';
import type { ArkadeSwaps } from '@arkade-os/boltz-swap';
import {
  mintTimedL402Macaroon,
  verifyL402Token,
  parseL402Header,
  type RootKeyStore,
} from './macaroon.js';
import { MacaroonStore } from './macaroon-store.js';
import type { GolemWallet } from '../wallet/golem-wallet.js';
import type { NetworkConfig } from '../config/networks.js';
import type { AlertManager } from '../monitoring/alerts.js';
import { getNearestExpiryMs, toExpiryInput } from '../agent/expiry.js';
import { validateBearerToken } from '../auth/safe-compare.js';
import { secureHeaders } from 'hono/secure-headers';
import { BOLTZ_MINIMUM_SATS } from './gateway.js';
import type { BoltzPollMonitor } from '../lightning/boltz-resilience.js';
import type { DurabilityReport } from '../server/data-durability.js';
import { spendableSats } from '../wallet/spendable-balance.js';
import type { BalanceChange } from '../agent/balance-monitor.js';

interface InternalApiConfig {
  lightning: ArkadeSwaps;
  wallet: GolemWallet;
  rootKeyStore: RootKeyStore;
  macaroonStore: MacaroonStore;
  networkConfig: NetworkConfig;
  startTime: number;
  alertManager?: AlertManager;
  refreshAgentRunning?: () => boolean;
  satsEarnedTotal?: () => number;
  apiKey?: string;
  /** Supplies the Boltz poll monitor for /internal/lightning-health (golem#2). */
  pollMonitor?: () => BoltzPollMonitor | null;
  /**
   * Supplies the boot-time wallet-storage durability report. Null when the check could not
   * run, which is reported as not-durable — an unanswered question about whether the wallet
   * survives a deploy is not a reassuring one.
   */
  durability?: () => DurabilityReport | null;
  /** Latest balance-change classification, for the alarm the 2026-07-25 loss lacked. */
  balanceChange?: () => BalanceChange | null;
  /**
   * Recovery signals the Atlas watchdog pages on: `recoverableSats` going nonzero is the
   * sweep, `lastRecoveryAt` advancing is the landing, and recoverable staying nonzero without
   * an advance is the stuck-recovery escalation.
   */
  recoveryStatus?: () => {
    pendingRecoverySats: number;
    recoverableSats: number;
    lastRecoveryAt: string | null;
  } | null;
}

export function createInternalApi(config: InternalApiConfig): Hono {
  const { lightning, wallet, rootKeyStore, macaroonStore, networkConfig, startTime } = config;
  const app = new Hono();

  // Security headers on all responses
  app.use('*', secureHeaders());

  // API key auth — fail-closed: POST endpoints require GOLEM_API_KEY.
  // GET endpoints (/l402/status, /admin/health) are intentionally unauthenticated:
  // they serve as health checks for monitoring and the server binds to 127.0.0.1
  // by default, so only local processes can reach them.
  const key = config.apiKey;
  app.use('*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    if (!key) {
      return c.json({ error: 'GOLEM_API_KEY required for POST endpoints' }, 403);
    }
    if (!validateBearerToken(c.req.header('Authorization'), key)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  /**
   * POST /l402/challenge
   * Request: { priceSats: number, durationHours: number }
   * Also accepts: { price_sats, duration_hours } or { price, bundle_size }
   *
   * Response expiresAt is ISO 8601 string — matches 402index's MockL402Provider format.
   * 402index middleware does `new Date(result.expiresAt) < new Date()` which requires
   * a value that `new Date()` can parse (ISO string or ms, NOT Unix seconds).
   */
  app.post('/l402/challenge', async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();

      // Normalize field names — 402index sends snake_case (price_sats, duration_hours)
      // but accept camelCase and shorthand too for robustness
      const priceSats = Number(body.priceSats ?? body.price_sats ?? body.price ?? 500);
      const durationHours = Number(body.durationHours ?? body.duration_hours ?? 24);

      if (isNaN(priceSats) || priceSats <= 0) {
        return c.json({ error: 'Invalid price_sats' }, 400);
      }
      if (priceSats < BOLTZ_MINIMUM_SATS) {
        return c.json({ error: `price_sats must be >= ${BOLTZ_MINIMUM_SATS} (Boltz minimum)` }, 400);
      }
      if (isNaN(durationHours) || durationHours <= 0) {
        return c.json({ error: 'Invalid duration_hours' }, 400);
      }

      // Create Lightning invoice via Boltz reverse swap
      const invoiceResult = await lightning.createLightningInvoice({ amount: priceSats });

      // Mint time-based macaroon with expires_at caveat
      const macResult = mintTimedL402Macaroon(rootKeyStore, {
        paymentHash: invoiceResult.paymentHash,
        durationHours,
        location: 'golem',
      });

      // Register in store for anti-replay tracking
      macaroonStore.register(invoiceResult.paymentHash, macResult.expiresAt, priceSats);

      return c.json({
        macaroon: macResult.macaroonBase64,
        invoice: invoiceResult.invoice,
        paymentHash: invoiceResult.paymentHash,
        expiresAt: new Date(macResult.expiresAt * 1000).toISOString(),
        durationHours,
        priceSats,
      });
    } catch (err) {
      console.error('/l402/challenge error:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Failed to create challenge' }, 500);
    }
  });

  /**
   * POST /l402/verify
   * Request: { authorization: string } — full "L402 <macaroon>:<preimage>" string
   * Response: { valid: boolean, expiresAt: string } — expiresAt is ISO 8601 string
   *
   * 402index middleware does `new Date(result.expiresAt) < new Date()` to check expiry.
   * MockL402Provider returns `new Date(...).toISOString()`. We match that format exactly.
   */
  app.post('/l402/verify', async (c) => {
    try {
      const body = await c.req.json<{ authorization: string }>();
      if (!body.authorization) {
        return c.json({ valid: false, expiresAt: null }, 400);
      }

      const parsed = parseL402Header(body.authorization);
      if (!parsed) {
        return c.json({ valid: false, expiresAt: null });
      }

      // Verify HMAC chain + preimage + time caveats
      const result = verifyL402Token(rootKeyStore, parsed.macaroon, parsed.preimage);
      if (!result.valid) {
        return c.json({ valid: false, expiresAt: null });
      }

      // Check server-side registration (anti-replay)
      if (result.paymentHash) {
        const storeResult = macaroonStore.verify(result.paymentHash);
        // Not in store AND no HMAC expiry → reject (expired or unknown)
        const isGatewayIssued = storeResult.expiresAt === 0 && result.expiresAt;
        if (!storeResult.valid && !isGatewayIssued) {
          return c.json({
            valid: false,
            expiresAt: storeResult.expiresAt
              ? new Date(storeResult.expiresAt * 1000).toISOString()
              : null,
          });
        }
        // If store says valid, or macaroon was gateway-issued with HMAC expiry → accept
      }

      return c.json({
        valid: true,
        expiresAt: result.expiresAt
          ? new Date(result.expiresAt * 1000).toISOString()
          : null,
      });
    } catch (err) {
      console.error('/l402/verify error:', err instanceof Error ? err.message : err);
      return c.json({ valid: false, expiresAt: null }, 500);
    }
  });

  /**
   * GET /l402/status
   * Health + metrics endpoint
   */
  app.get('/l402/status', async (c) => {
    try {
      const [balance, vtxos] = await Promise.all([
        wallet.getBalance(),
        wallet.getVtxos(),
      ]);

      // Calculate nearest VTXO expiry
      const nearestMs = getNearestExpiryMs(toExpiryInput(vtxos));
      const nearestExpiryHours = nearestMs !== null ? nearestMs / (3600 * 1000) : Infinity;

      // Check Boltz reachability
      let boltzReachable = false;
      try {
        const res = await fetch(`${networkConfig.boltzApiUrl}/version`, { signal: AbortSignal.timeout(5000) });
        boltzReachable = res.ok;
      } catch { /* network error — reported as unreachable */ }

      // Check ASP reachability
      let aspReachable = false;
      try {
        const res = await fetch(`${networkConfig.arkServerUrl}/v1/info`, { signal: AbortSignal.timeout(5000) });
        aspReachable = res.ok;
      } catch { /* network error — reported as unreachable */ }

      return c.json({
        healthy: true,
        network: networkConfig.golemNetwork,
        walletBalanceSats: balance.total,
        // `total` alone is misleading since sdk 0.4.51: it also carries funds that cannot be
        // spent yet. `pendingRecovery` is money under a signer the ASP deprecated past its
        // cutoff and has not swept; `recoverable` is money already swept and awaiting a
        // recovery settle. Splitting them is also how the sweep gets observed — pendingRecovery
        // falls to zero and recoverable rises.
        spendableSats: spendableSats(balance),
        pendingRecoverySats: balance.pendingRecovery ?? 0,
        recoverableSats: balance.recoverable ?? 0,
        vtxoCount: vtxos.length,
        nearestExpiryHours: nearestExpiryHours === Infinity ? -1 : Math.round(nearestExpiryHours * 10) / 10,
        refreshAgentRunning: config.refreshAgentRunning ? config.refreshAgentRunning() : false,
        activeMacaroons: macaroonStore.activeCount(),
        // Split out so self-probe noise stops reading as demand. The Atlas watchdog mints a
        // challenge every probe and never pays it — 2,583 macaroons, zero payments, as of
        // 2026-07-26. `paidMacaroons` is the number that means business.
        paidMacaroons: macaroonStore.verifiedCount(),
        unpaidMacaroons: macaroonStore.activeCount() - macaroonStore.verifiedCount(),
        boltzReachable,
        aspReachable,
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        satsEarnedTotal: config.satsEarnedTotal ? config.satsEarnedTotal() : 0,
        lastAlert: config.alertManager?.lastAlertTime ?? null,
      });
    } catch (err) {
      console.error('/l402/status error:', err instanceof Error ? err.message : err);
      return c.json({
        healthy: false,
        error: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  });

  // Alias: /admin/health = /l402/status
  app.get('/admin/health', async (c) => {
    const statusRes = await app.request('/l402/status');
    const body = await statusRes.json();
    return c.json(body, statusRes.status as 200);
  });

  /**
   * GET /internal/lightning-health (golem#2)
   *
   * Reports whether the swap poller is still bound to Boltz. Unlike /l402/status this is
   * auth-gated: it exposes operational internals (subscription epoch, suppressed-error
   * counts) rather than a public liveness signal.
   *
   * Read-only on purpose — see the note on `ensureSwapManagerHealthy`. 503 when the breaker
   * is open so a monitor can alert on status code alone.
   */
  app.get('/internal/lightning-health', (c) => {
    if (!key || !validateBearerToken(c.req.header('Authorization'), key)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const durability = config.durability?.() ?? null;

    const monitor = config.pollMonitor?.() ?? null;
    if (!monitor) {
      return c.json(
        {
          healthy: false,
          reason: 'poll monitor unavailable — Lightning init did not complete',
          durable: durability?.durable ?? false,
          durability,
        },
        503,
      );
    }

    const health = monitor.getHealth();
    const healthy = health.breakerState === 'closed';

    return c.json(
      {
        healthy,
        // Whether ark-sdk.db — contract repository, tx history, unilateral-exit material —
        // is on storage that survives a deploy. Deliberately not folded into `healthy`:
        // that flag means "the poller is bound to Boltz" and drives the 503 an external
        // watchdog alerts on. A wallet whose storage is ephemeral is broken in a different
        // way and on a different timescale.
        durable: durability?.durable ?? false,
        durability,
        // What the balance last did, and whether that was alarming. `funds-vanished` and
        // `funds-stranded` are the two that mean money is not where it should be.
        balanceChange: config.balanceChange?.() ?? null,
        // Always present, null when unwired — the watchdog reads `.recovery` unconditionally
        // and a missing key would read as a crash rather than "not configured".
        recovery: config.recoveryStatus?.() ?? null,
        breakerState: health.breakerState,
        subscriptionEpoch: health.subscriptionEpoch,
        lastSuccessfulPollAt: health.lastSuccessfulPollAt,
        lastSuccessfulPollIso:
          health.lastSuccessfulPollAt === null
            ? null
            : new Date(health.lastSuccessfulPollAt).toISOString(),
        errorCount60s: health.errorCount60s,
        consecutiveFailures: health.consecutiveFailures,
        monitoredSwaps: health.monitoredSwaps,
        websocketConnected: health.websocketConnected,
        breakerOpenedAt: health.openedAt,
        suppressedSinceOpen: health.suppressedSinceOpen,
      },
      healthy ? 200 : 503,
    );
  });

  return app;
}
