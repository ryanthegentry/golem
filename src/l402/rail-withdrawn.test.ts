/**
 * Stop calling a swap provider that has told us to stop.
 *
 * On 2026-08-05 Boltz said the shutdown is indefinite, and said why: months of rising
 * automated, AI-assisted probing, several contained exploits, and "attackers now iterate
 * faster than a team our size can find and patch". They are bootstrapped, they ate the
 * losses themselves, and they are unsure whether swaps resume at all.
 *
 * Meanwhile we had been POSTing swap creation to them roughly seventy times a day for three
 * days — the Atlas watchdog mints a challenge every thirty minutes and never pays it. Every
 * one of those is a failed swap-creation attempt from an automated client against a company
 * racing to patch under attack. That is the exact traffic profile they described, and it is
 * pure waste: we already know the answer.
 *
 * So the monitor's job splits in two. Discovering that creation broke is what it was built
 * for. Knowing that the rail has been withdrawn is a declared operational fact, and once
 * declared we should stop asking.
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

describe('swap rail withdrawn', () => {
  let tmpDir: string;
  let macaroonStore: MacaroonStore;
  let app: Hono;
  let createLightningInvoice: ReturnType<typeof vi.fn>;
  let sentAlerts: string[];

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-rail-withdrawn-'));
    macaroonStore = new MacaroonStore(path.join(tmpDir, 'macaroons.db'));

    createLightningInvoice = vi.fn().mockImplementation(async () => ({
      invoice: 'lntbs500n1ptest...',
      paymentHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    }));

    sentAlerts = [];
    const alertManager = new AlertManager(null);
    vi.spyOn(alertManager, 'alert').mockImplementation(async (_k: string, m: string) => {
      sentAlerts.push(m);
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
      swapRailWithdrawn: () => true,
    });
  });

  afterEach(() => {
    macaroonStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.GOLEM_SWAP_RAIL_WITHDRAWN;
  });

  it('does not touch the swap provider at all', async () => {
    await challenge();
    await challenge();

    expect(createLightningInvoice).not.toHaveBeenCalled();
  });

  it('still refuses the challenge, rather than pretending it worked', async () => {
    const res = await challenge();
    expect(res.status).toBe(503);
  });

  it('says the rail is withdrawn, not that it merely failed', async () => {
    const { res, body } = await status();
    expect(res.status).toBe(503);
    expect(body.healthy).toBe(false);
    expect(body.swapCreation.creatable).toBe(false);
    expect(body.swapCreation.classification).toBe('withdrawn');
  });

  it('does not alert — a declared state is not a new incident', async () => {
    await challenge();
    await challenge();

    expect(sentAlerts).toHaveLength(0);
  });

  it('reads the env var, so the rail can be cut without a deploy', async () => {
    const envApp = createInternalApi({
      lightning: { createLightningInvoice, startSwapManager: vi.fn() } as any,
      wallet: {
        getBalance: vi.fn().mockResolvedValue({
          total: 1, available: 1, settled: 1,
          boarding: { total: 0, confirmed: 0, unconfirmed: 0 },
          preconfirmed: 0, recoverable: 0,
        }),
        getVtxos: vi.fn().mockResolvedValue([]),
      } as any,
      rootKeyStore: new MemoryRootKeyStore(),
      macaroonStore,
      networkConfig: NETWORK_CONFIGS.mutinynet,
      startTime: Date.now(),
      apiKey: 'test-api-key',
    });

    process.env.GOLEM_SWAP_RAIL_WITHDRAWN = 'true';
    const res = await envApp.request('/l402/challenge', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ priceSats: 500 }),
    });

    expect(res.status).toBe(503);
    expect(createLightningInvoice).not.toHaveBeenCalled();
  });

  it('resumes calling the provider the moment the flag is cleared', async () => {
    const liveApp = createInternalApi({
      lightning: { createLightningInvoice, startSwapManager: vi.fn() } as any,
      wallet: {
        getBalance: vi.fn().mockResolvedValue({
          total: 1, available: 1, settled: 1,
          boarding: { total: 0, confirmed: 0, unconfirmed: 0 },
          preconfirmed: 0, recoverable: 0,
        }),
        getVtxos: vi.fn().mockResolvedValue([]),
      } as any,
      rootKeyStore: new MemoryRootKeyStore(),
      macaroonStore,
      networkConfig: NETWORK_CONFIGS.mutinynet,
      startTime: Date.now(),
      apiKey: 'test-api-key',
    });

    const res = await liveApp.request('/l402/challenge', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ priceSats: 500 }),
    });

    expect(res.status).toBe(200);
    expect(createLightningInvoice).toHaveBeenCalledTimes(1);
  });
});
