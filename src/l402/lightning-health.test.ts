/**
 * GET /internal/lightning-health (golem#2, item 5).
 *
 * Surfaces what the external Atlas watchdog cannot see: whether the swap poller is actually
 * talking to Boltz. The watchdog only proves the 402 challenge endpoint answers; this proves
 * the subscription behind it is alive.
 *
 * Read-only by design. It reports state and never rebinds — a health poll that mutates the
 * thing it measures turns a monitoring loop into a restart loop.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Hono } from 'hono';
import { createInternalApi } from './internal-api.js';
import { MemoryRootKeyStore } from './macaroon.js';
import { MacaroonStore } from './macaroon-store.js';
import { NETWORK_CONFIGS } from '../config/networks.js';
import { BoltzPollMonitor } from '../lightning/boltz-resilience.js';

const API_KEY = 'test-api-key-for-lightning-health';

describe('GET /internal/lightning-health', () => {
  let tmpDir: string;
  let app: Hono;
  let monitor: BoltzPollMonitor;
  let clock: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-ln-health-'));
    clock = 1_700_000_000_000;

    monitor = new BoltzPollMonitor({
      sink: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => clock,
      failureThreshold: 3,
    });

    app = createInternalApi({
      lightning: { createLightningInvoice: vi.fn(), startSwapManager: vi.fn() } as any,
      wallet: {
        getBalance: vi.fn().mockResolvedValue({ total: 1000 }),
        getVtxos: vi.fn().mockResolvedValue([]),
      } as any,
      rootKeyStore: new MemoryRootKeyStore(),
      macaroonStore: new MacaroonStore(path.join(tmpDir, 'macaroons.db')),
      networkConfig: NETWORK_CONFIGS.mutinynet,
      startTime: Date.now(),
      apiKey: API_KEY,
      pollMonitor: () => monitor,
    });
  });

  afterEach(() => {
    monitor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const authed = () => ({ headers: { Authorization: `Bearer ${API_KEY}` } });

  it('requires authentication', async () => {
    const res = await app.request('/internal/lightning-health');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer token', async () => {
    const res = await app.request('/internal/lightning-health', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    expect(res.status).toBe(401);
  });

  it('returns the three signals the issue asks for', async () => {
    await monitor.recordProbeResult(true);
    const res = await app.request('/internal/lightning-health', authed());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('subscriptionEpoch');
    expect(body).toHaveProperty('lastSuccessfulPollAt');
    expect(body).toHaveProperty('errorCount60s');
    expect(body.lastSuccessfulPollAt).not.toBeNull();
  });

  it('reports healthy while the breaker is closed', async () => {
    await monitor.recordProbeResult(true);
    const res = await app.request('/internal/lightning-health', authed());
    const body = await res.json();

    expect(body.healthy).toBe(true);
    expect(body.breakerState).toBe('closed');
  });

  it('reports unhealthy with a 503 once the breaker opens', async () => {
    const logger = monitor.createSdkLogger();
    for (let i = 0; i < 3; i++) logger.error('Failed to poll swap s1:');

    const res = await app.request('/internal/lightning-health', authed());
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.breakerState).toBe('open');
    expect(body.errorCount60s).toBe(3);
  });

  it('does not mutate poller state — repeated polls are side-effect free', async () => {
    await monitor.recordProbeResult(true);
    const before = monitor.getHealth();

    for (let i = 0; i < 5; i++) await app.request('/internal/lightning-health', authed());

    const after = monitor.getHealth();
    expect(after.subscriptionEpoch).toBe(before.subscriptionEpoch);
    expect(after.breakerState).toBe(before.breakerState);
  });

  it('degrades gracefully when no monitor is wired', async () => {
    const bare = createInternalApi({
      lightning: { createLightningInvoice: vi.fn(), startSwapManager: vi.fn() } as any,
      wallet: { getBalance: vi.fn(), getVtxos: vi.fn() } as any,
      rootKeyStore: new MemoryRootKeyStore(),
      macaroonStore: new MacaroonStore(path.join(tmpDir, 'macaroons-2.db')),
      networkConfig: NETWORK_CONFIGS.mutinynet,
      startTime: Date.now(),
      apiKey: API_KEY,
    });

    const res = await bare.request('/internal/lightning-health', authed());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    expect(body.reason).toMatch(/unavailable/i);
  });
});
