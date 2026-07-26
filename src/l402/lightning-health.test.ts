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

/**
 * The wallet-storage durability flag. Separate from `healthy`, which stays tied to the
 * breaker: "the poller is wedged" and "my database is about to be deleted" are different
 * alarms and the 503 already means the first one.
 */
describe('GET /internal/lightning-health — wallet storage durability', () => {
  let tmpDir: string;
  let monitor: BoltzPollMonitor;

  const report = (durable: boolean) => ({
    dataDir: './data-l402/wallet',
    resolvedPath: durable ? '/app/data-l402/wallet' : '/app/data',
    durable,
    confidence: durable ? ('proven-persistent' as const) : ('proven-ephemeral' as const),
    reason: durable ? 'mount /app/data-l402 is ext4' : 'mount / uses the overlay filesystem',
    mountPoint: durable ? '/app/data-l402' : '/',
    fsType: durable ? 'ext4' : 'overlay',
    bootCount: 2,
    previousBootAt: '2026-07-25T10:00:00.000Z',
    markerSurvived: durable,
  });

  const build = (durability?: () => ReturnType<typeof report> | null) =>
    createInternalApi({
      lightning: { createLightningInvoice: vi.fn(), startSwapManager: vi.fn() } as any,
      wallet: { getBalance: vi.fn(), getVtxos: vi.fn() } as any,
      rootKeyStore: new MemoryRootKeyStore(),
      macaroonStore: new MacaroonStore(path.join(tmpDir, `m-${Math.random()}.db`)),
      networkConfig: NETWORK_CONFIGS.mutinynet,
      startTime: Date.now(),
      apiKey: API_KEY,
      pollMonitor: () => monitor,
      durability,
    });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-ln-durable-'));
    monitor = new BoltzPollMonitor({ sink: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });

  afterEach(() => {
    monitor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const authed = () => ({ headers: { Authorization: `Bearer ${API_KEY}` } });

  it('carries durable=false when the wallet dir is on the overlay', async () => {
    const res = await build(() => report(false)).request('/internal/lightning-health', authed());
    const body = await res.json();

    expect(body.durable).toBe(false);
    expect(body.durability.fsType).toBe('overlay');
    expect(body.durability.resolvedPath).toBe('/app/data');
    expect(body.durability.confidence).toBe('proven-ephemeral');
  });

  it('carries durable=true when the wallet dir is on the volume', async () => {
    const res = await build(() => report(true)).request('/internal/lightning-health', authed());
    const body = await res.json();

    expect(body.durable).toBe(true);
    expect(body.durability.mountPoint).toBe('/app/data-l402');
    expect(body.durability.bootCount).toBe(2);
    expect(body.durability.markerSurvived).toBe(true);
  });

  it('keeps healthy tied to the breaker — a durable=false wallet still answers 200', async () => {
    // The two signals must not be conflated: the poller is fine, the storage is not.
    const res = await build(() => report(false)).request('/internal/lightning-health', authed());

    expect(res.status).toBe(200);
    expect((await res.json()).healthy).toBe(true);
  });

  it('reports durable=false when the check could not run at all', async () => {
    const res = await build(() => null).request('/internal/lightning-health', authed());
    const body = await res.json();

    expect(body.durable).toBe(false);
    expect(body.durability).toBeNull();
  });

  it('reports durable=false when no durability probe is wired', async () => {
    const res = await build().request('/internal/lightning-health', authed());
    expect((await res.json()).durable).toBe(false);
  });

  it('stays behind auth', async () => {
    const res = await build(() => report(true)).request('/internal/lightning-health');
    expect(res.status).toBe(401);
  });
});

/**
 * Recovery signals. The Atlas watchdog polls this endpoint and pages on transitions, so these
 * three fields are the contract it reads: `recoverableSats` going nonzero is SWEEP DETECTED,
 * `lastRecoveryAt` advancing is RECOVERY LANDED, and recoverable staying nonzero with no
 * advance is the stuck-recovery escalation.
 */
describe('GET /internal/lightning-health — recovery signals', () => {
  let tmpDir: string;
  let monitor: BoltzPollMonitor;

  const build = (recoveryStatus?: () => { pendingRecoverySats: number; recoverableSats: number; lastRecoveryAt: string | null } | null) =>
    createInternalApi({
      lightning: { createLightningInvoice: vi.fn(), startSwapManager: vi.fn() } as any,
      wallet: { getBalance: vi.fn(), getVtxos: vi.fn() } as any,
      rootKeyStore: new MemoryRootKeyStore(),
      macaroonStore: new MacaroonStore(path.join(tmpDir, `r-${Math.random()}.db`)),
      networkConfig: NETWORK_CONFIGS.mutinynet,
      startTime: Date.now(),
      apiKey: API_KEY,
      pollMonitor: () => monitor,
      recoveryStatus,
    });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-ln-recov-'));
    monitor = new BoltzPollMonitor({ sink: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });
  afterEach(() => { monitor.stop(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const authed = () => ({ headers: { Authorization: `Bearer ${API_KEY}` } });

  it('reports the pre-sweep state: pending, nothing recoverable, never recovered', async () => {
    const res = await build(() => ({ pendingRecoverySats: 34_882, recoverableSats: 0, lastRecoveryAt: null }))
      .request('/internal/lightning-health', authed());
    const b = await res.json();
    expect(b.recovery.pendingRecoverySats).toBe(34_882);
    expect(b.recovery.recoverableSats).toBe(0);
    expect(b.recovery.lastRecoveryAt).toBeNull();
  });

  it('reports the post-sweep state the watchdog pages on', async () => {
    const res = await build(() => ({ pendingRecoverySats: 0, recoverableSats: 34_882, lastRecoveryAt: null }))
      .request('/internal/lightning-health', authed());
    const b = await res.json();
    expect(b.recovery.recoverableSats).toBe(34_882);
    expect(b.recovery.pendingRecoverySats).toBe(0);
  });

  it('reports a landed recovery', async () => {
    const res = await build(() => ({ pendingRecoverySats: 0, recoverableSats: 0, lastRecoveryAt: '2026-07-29T15:02:00.000Z' }))
      .request('/internal/lightning-health', authed());
    expect((await res.json()).recovery.lastRecoveryAt).toBe('2026-07-29T15:02:00.000Z');
  });

  it('degrades to nulls rather than omitting the key when unwired', async () => {
    // The watchdog reads .recovery unconditionally; a missing key would read as a crash.
    const res = await build().request('/internal/lightning-health', authed());
    const b = await res.json();
    expect(b).toHaveProperty('recovery');
    expect(b.recovery).toBeNull();
  });
});
