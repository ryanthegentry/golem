/**
 * /l402/status must go unhealthy when swaps cannot be created.
 *
 * The 2026-08-03 failure was not that the health check was wrong about its own question. It
 * answered "is Boltz reachable?" correctly — Boltz was reachable, `GET /version` returned 200
 * all day. It was the wrong question. Creation was off; every read endpoint was fine; the
 * status surface reported `healthy: true` for three hours and seventeen minutes while the
 * index could not take a single payment.
 *
 * These tests pin the endpoint to the capability rather than the dependency, and pin the 503
 * that an external watchdog can actually alert on — matching the contract
 * `/internal/lightning-health` already uses for its circuit breaker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { createInternalApi } from './internal-api.js';
import { MemoryRootKeyStore } from './macaroon.js';
import { MacaroonStore } from './macaroon-store.js';
import { NETWORK_CONFIGS } from '../config/networks.js';
import { AlertManager } from '../monitoring/alerts.js';

const AUTH = { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-api-key' };
const BOLTZ_DISABLED = 'Boltz API error: 400 {"error":"swap creation is disabled"}';

function makePaymentHash(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex');
}

describe('swap-creation health on /l402/status', () => {
  let tmpDir: string;
  let macaroonStore: MacaroonStore;
  let app: Hono;
  let createLightningInvoice: ReturnType<typeof vi.fn>;
  let alertManager: AlertManager;
  let sentAlerts: Array<{ key: string; message: string }>;

  async function challenge() {
    return app.request('/l402/challenge', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ priceSats: 500, durationHours: 24 }),
    });
  }

  async function status() {
    const res = await app.request('/l402/status');
    return { res, body: await res.json() as Record<string, any> };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-swap-health-'));
    macaroonStore = new MacaroonStore(path.join(tmpDir, 'macaroons.db'));

    createLightningInvoice = vi.fn().mockImplementation(async () => ({
      invoice: 'lntbs500n1ptest...',
      paymentHash: makePaymentHash(),
    }));

    sentAlerts = [];
    alertManager = new AlertManager(null);
    vi.spyOn(alertManager, 'alert').mockImplementation(async (key: string, message: string) => {
      sentAlerts.push({ key, message });
      return true;
    });

    app = createInternalApi({
      lightning: { createLightningInvoice, startSwapManager: vi.fn() } as any,
      wallet: {
        getBalance: vi.fn().mockResolvedValue({
          total: 34882, available: 34882, settled: 34882,
          boarding: { total: 0, confirmed: 0, unconfirmed: 0 },
          preconfirmed: 0, recoverable: 0,
        }),
        getVtxos: vi.fn().mockResolvedValue([
          { txid: 'abc', vout: 0, value: 34882, virtualStatus: { state: 'settled' } },
        ]),
      } as any,
      rootKeyStore: new MemoryRootKeyStore(),
      macaroonStore,
      networkConfig: NETWORK_CONFIGS.mutinynet,
      startTime: Date.now(),
      apiKey: 'test-api-key',
      alertManager,
    });
  });

  afterEach(() => {
    macaroonStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports swapCreation alongside the existing fields', async () => {
    const { res, body } = await status();
    expect(res.status).toBe(200);
    expect(body.swapCreation).toBeDefined();
    expect(body.swapCreation.creatable).toBe(true);
  });

  it('goes unhealthy and 503 after the upstream refuses to create a swap', async () => {
    createLightningInvoice.mockRejectedValue(new Error(BOLTZ_DISABLED));
    await challenge();

    const { res, body } = await status();
    expect(res.status).toBe(503);
    expect(body.healthy).toBe(false);
    expect(body.swapCreation.creatable).toBe(false);
    expect(body.swapCreation.classification).toBe('refused');
    expect(body.swapCreation.lastError).toContain('swap creation is disabled');
  });

  it('stays healthy through the flakiness that self-heals', async () => {
    createLightningInvoice.mockRejectedValue(new Error('NetworkError: fetch failed'));
    await challenge();
    await challenge();

    const { res, body } = await status();
    expect(res.status).toBe(200);
    expect(body.healthy).toBe(true);
    expect(body.swapCreation.consecutiveFailures).toBe(2);
  });

  it('goes unhealthy once transient failures stop being occasional', async () => {
    createLightningInvoice.mockRejectedValue(new Error('NetworkError: fetch failed'));
    await challenge();
    await challenge();
    await challenge();

    const { res, body } = await status();
    expect(res.status).toBe(503);
    expect(body.healthy).toBe(false);
  });

  it('recovers to 200 on the next challenge that succeeds', async () => {
    createLightningInvoice.mockRejectedValue(new Error(BOLTZ_DISABLED));
    await challenge();
    expect((await status()).res.status).toBe(503);

    createLightningInvoice.mockImplementation(async () => ({
      invoice: 'lntbs500n1ptest...',
      paymentHash: makePaymentHash(),
    }));
    await challenge();

    const { res, body } = await status();
    expect(res.status).toBe(200);
    expect(body.healthy).toBe(true);
    expect(body.swapCreation.creatable).toBe(true);
  });

  it('keeps boltzReachable, which answers a different and still useful question', async () => {
    const { body } = await status();
    expect(body).toHaveProperty('boltzReachable');
  });

  it('does not disturb the wallet fields the watchdog already reads', async () => {
    createLightningInvoice.mockRejectedValue(new Error(BOLTZ_DISABLED));
    await challenge();

    const { body } = await status();
    expect(body.walletBalanceSats).toBe(34882);
    expect(body).toHaveProperty('spendableSats');
    expect(body).toHaveProperty('paidMacaroons');
    expect(body).toHaveProperty('unpaidMacaroons');
  });

  describe('alerting', () => {
    it('alerts on the transition into an outage', async () => {
      createLightningInvoice.mockRejectedValue(new Error(BOLTZ_DISABLED));
      await challenge();

      expect(sentAlerts).toHaveLength(1);
      expect(sentAlerts[0].message).toMatch(/swap creation/i);
    });

    it('does not re-alert on every subsequent failure', async () => {
      createLightningInvoice.mockRejectedValue(new Error(BOLTZ_DISABLED));
      await challenge();
      await challenge();
      await challenge();

      expect(sentAlerts).toHaveLength(1);
    });

    it('alerts again when creation comes back, so the outage gets closed out', async () => {
      createLightningInvoice.mockRejectedValue(new Error(BOLTZ_DISABLED));
      await challenge();

      createLightningInvoice.mockImplementation(async () => ({
        invoice: 'lntbs500n1ptest...',
        paymentHash: makePaymentHash(),
      }));
      await challenge();

      expect(sentAlerts).toHaveLength(2);
      expect(sentAlerts[1].message).toMatch(/recover/i);
    });
  });

  it('still answers the challenge with a 500, so 402index behaviour is unchanged', async () => {
    createLightningInvoice.mockRejectedValue(new Error(BOLTZ_DISABLED));
    const res = await challenge();
    expect(res.status).toBe(500);
  });
});
