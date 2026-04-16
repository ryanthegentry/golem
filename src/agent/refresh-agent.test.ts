import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RefreshAgent, DEFAULT_REFRESH_CONFIG } from './refresh-agent.js';
import type { RefreshEvent } from './refresh-agent.js';
import type { GolemWallet } from '../wallet/golem-wallet.js';

/** Helper to build a fake VTXO with a given value and state */
function fakeVtxo(value: number, state: 'settled' | 'preconfirmed' | 'spent' = 'settled', batchExpiry?: number) {
  return { txid: `tx-${value}`, vout: 0, value, virtualStatus: { state, batchExpiry: batchExpiry ?? 0 } };
}

function createMockWallet(overrides: Partial<GolemWallet> = {}): GolemWallet {
  return {
    getExpiringVtxos: vi.fn().mockResolvedValue([]),
    renewVtxos: vi.fn().mockResolvedValue('mock-txid-123'),
    getVtxos: vi.fn().mockResolvedValue([]),
    consolidateVtxos: vi.fn().mockResolvedValue('consolidate-txid-789'),
    ...overrides,
  } as unknown as GolemWallet;
}

const BASE_CONFIG = { pollIntervalMs: 1000, safetyMarginMs: 60_000, maxVtxoCount: 10, dustThresholdSats: 1000, safeHarborExitThresholdBlocks: 432 };

describe('RefreshAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and stops cleanly', () => {
    const wallet = createMockWallet();
    const agent = new RefreshAgent(wallet, BASE_CONFIG);

    expect(agent.isRunning).toBe(false);
    agent.start();
    expect(agent.isRunning).toBe(true);
    agent.stop();
    expect(agent.isRunning).toBe(false);
  });

  it('start is idempotent', () => {
    const wallet = createMockWallet();
    const agent = new RefreshAgent(wallet, BASE_CONFIG);

    agent.start();
    agent.start(); // should not create duplicate timers
    expect(agent.isRunning).toBe(true);
    agent.stop();
  });

  it('emits check event with vtxoCount and dustCount', async () => {
    const vtxos = [fakeVtxo(5000), fakeVtxo(500), fakeVtxo(200)];
    const wallet = createMockWallet({ getVtxos: vi.fn().mockResolvedValue(vtxos) });
    const events: RefreshEvent[] = [];
    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

    await agent.tick();

    const check = events.find(e => e.type === 'check');
    expect(check).toBeTruthy();
    if (check?.type === 'check') {
      expect(check.expiringCount).toBe(0);
      expect(check.vtxoCount).toBe(3);
      expect(check.dustCount).toBe(2); // 500 and 200 are < 1000
      expect(check.nearestExpiryMs).toBeNull(); // no batchExpiry set
      expect(check.totalBalanceSats).toBe(5700); // 5000 + 500 + 200
    }
  });

  it('emits check event with nearestExpiryMs from VTXO batch expiry', async () => {
    const now = Date.now();
    // One VTXO expires in 2 days (ms), another in 5 days (ms)
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    const vtxos = [
      fakeVtxo(10000, 'settled', now + fiveDaysMs),
      fakeVtxo(20000, 'settled', now + twoDaysMs),
    ];
    const wallet = createMockWallet({ getVtxos: vi.fn().mockResolvedValue(vtxos) });
    const events: RefreshEvent[] = [];
    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

    await agent.tick();

    const check = events.find(e => e.type === 'check');
    expect(check).toBeTruthy();
    if (check?.type === 'check') {
      // nearestExpiryMs should be close to 2 days (allow 1s tolerance for test execution)
      expect(check.nearestExpiryMs).not.toBeNull();
      expect(check.nearestExpiryMs!).toBeGreaterThan(twoDaysMs - 1000);
      expect(check.nearestExpiryMs!).toBeLessThanOrEqual(twoDaysMs);
      expect(check.totalBalanceSats).toBe(30000); // 10000 + 20000
    }
  });

  it('emits check event with nearestExpiryMs converted from seconds-based expiry', async () => {
    const now = Date.now();
    // Simulate a seconds-based expiry (value < 1e12, treated as seconds)
    const threeDaysSec = 3 * 24 * 60 * 60;
    const expiryInSeconds = Math.floor(now / 1000) + threeDaysSec;
    const vtxos = [fakeVtxo(5000, 'settled', expiryInSeconds)];
    const wallet = createMockWallet({ getVtxos: vi.fn().mockResolvedValue(vtxos) });
    const events: RefreshEvent[] = [];
    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

    await agent.tick();

    const check = events.find(e => e.type === 'check');
    expect(check).toBeTruthy();
    if (check?.type === 'check') {
      const threeDaysMs = threeDaysSec * 1000;
      expect(check.nearestExpiryMs).not.toBeNull();
      // Allow 1s tolerance
      expect(check.nearestExpiryMs!).toBeGreaterThan(threeDaysMs - 1000);
      expect(check.nearestExpiryMs!).toBeLessThanOrEqual(threeDaysMs);
    }
  });

  it('triggers renewal when VTXOs are expiring', async () => {
    const fakeVtxos = [{ txid: 'abc', vout: 0 }];
    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(fakeVtxos),
      renewVtxos: vi.fn().mockResolvedValue('renewed-txid-456'),
    });
    const events: RefreshEvent[] = [];
    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

    await agent.tick();

    expect(events).toHaveLength(3); // check, refresh_start, refresh_ok
    expect(events[0].type).toBe('check');
    expect(events[1].type).toBe('refresh_start');
    expect(events[2].type).toBe('refresh_ok');
    if (events[2].type === 'refresh_ok') {
      expect(events[2].txid).toBe('renewed-txid-456');
    }
    expect(wallet.renewVtxos).toHaveBeenCalledOnce();
  });

  it('emits error event when renewal fails', async () => {
    const fakeVtxos = [{ txid: 'abc', vout: 0 }];
    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(fakeVtxos),
      renewVtxos: vi.fn().mockRejectedValue(new Error('network timeout')),
    });
    const events: RefreshEvent[] = [];
    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

    await agent.tick();

    expect(events).toHaveLength(3);
    expect(events[2].type).toBe('refresh_error');
    if (events[2].type === 'refresh_error') {
      expect(events[2].error).toBe('network timeout');
    }
  });

  it('emits error event when check fails', async () => {
    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockRejectedValue(new Error('server down')),
    });
    const events: RefreshEvent[] = [];
    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

    await agent.tick();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('refresh_error');
    if (events[0].type === 'refresh_error') {
      expect(events[0].error).toBe('server down');
    }
  });

  it('emits stopped event on stop', () => {
    const wallet = createMockWallet();
    const events: RefreshEvent[] = [];
    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

    agent.start();
    agent.stop();

    const stopped = events.find((e) => e.type === 'stopped');
    expect(stopped).toBeTruthy();
  });

  it('polls on interval', async () => {
    const wallet = createMockWallet();
    const agent = new RefreshAgent(wallet, { ...BASE_CONFIG, pollIntervalMs: 5000 });

    agent.start();

    // Initial tick runs immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(wallet.getExpiringVtxos).toHaveBeenCalledTimes(1);

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(5000);
    expect(wallet.getExpiringVtxos).toHaveBeenCalledTimes(2);

    // Advance past another interval
    await vi.advanceTimersByTimeAsync(5000);
    expect(wallet.getExpiringVtxos).toHaveBeenCalledTimes(3);

    agent.stop();

    // No more calls after stop
    await vi.advanceTimersByTimeAsync(5000);
    expect(wallet.getExpiringVtxos).toHaveBeenCalledTimes(3);
  });

  describe('default config', () => {
    it('has consolidation defaults', () => {
      expect(DEFAULT_REFRESH_CONFIG.maxVtxoCount).toBe(10);
      expect(DEFAULT_REFRESH_CONFIG.dustThresholdSats).toBe(1000);
    });
  });

  describe('consolidation', () => {
    it('triggers consolidation when VTXO count exceeds maxVtxoCount', async () => {
      // 12 VTXOs, all above dust threshold
      const vtxos = Array.from({ length: 12 }, (_, i) => fakeVtxo(5000 + i));
      const wallet = createMockWallet({ getVtxos: vi.fn().mockResolvedValue(vtxos) });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      const types = events.map(e => e.type);
      expect(types).toContain('consolidation_start');
      expect(types).toContain('consolidation_ok');
      expect(wallet.consolidateVtxos).toHaveBeenCalledOnce();
      expect(wallet.consolidateVtxos).toHaveBeenCalledWith(vtxos);
    });

    it('triggers consolidation when dust VTXOs exist', async () => {
      // 3 VTXOs, one is dust (below 1000 sats)
      const vtxos = [fakeVtxo(5000), fakeVtxo(3000), fakeVtxo(500)];
      const wallet = createMockWallet({ getVtxos: vi.fn().mockResolvedValue(vtxos) });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      const start = events.find(e => e.type === 'consolidation_start');
      expect(start).toBeTruthy();
      if (start?.type === 'consolidation_start') {
        expect(start.vtxoCount).toBe(3); // ALL spendable VTXOs included
        expect(start.totalSats).toBe(8500);
      }
      // consolidateVtxos called with ALL spendable VTXOs, not just dust
      expect(wallet.consolidateVtxos).toHaveBeenCalledWith(vtxos);
    });

    it('skips consolidation when not needed', async () => {
      // 3 VTXOs, all above dust, under maxVtxoCount
      const vtxos = [fakeVtxo(5000), fakeVtxo(3000), fakeVtxo(2000)];
      const wallet = createMockWallet({ getVtxos: vi.fn().mockResolvedValue(vtxos) });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      const skip = events.find(e => e.type === 'consolidation_skip');
      expect(skip).toBeTruthy();
      if (skip?.type === 'consolidation_skip') {
        expect(skip.reason).toBe('not needed');
      }
      expect(wallet.consolidateVtxos).not.toHaveBeenCalled();
    });

    it('skips consolidation when only 1 spendable VTXO', async () => {
      const vtxos = [fakeVtxo(500)]; // dust, but only 1 VTXO — can't consolidate
      const wallet = createMockWallet({ getVtxos: vi.fn().mockResolvedValue(vtxos) });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      expect(events.find(e => e.type === 'consolidation_skip')).toBeTruthy();
      expect(wallet.consolidateVtxos).not.toHaveBeenCalled();
    });

    it('skips consolidation when refresh already happened this tick', async () => {
      const expiringVtxos = [{ txid: 'exp-1', vout: 0 }];
      // Many VTXOs that would trigger consolidation
      const allVtxos = Array.from({ length: 15 }, (_, i) => fakeVtxo(5000 + i));
      const wallet = createMockWallet({
        getExpiringVtxos: vi.fn().mockResolvedValue(expiringVtxos),
        getVtxos: vi.fn().mockResolvedValue(allVtxos),
        renewVtxos: vi.fn().mockResolvedValue('refresh-txid'),
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      // Refresh happened
      expect(events.find(e => e.type === 'refresh_ok')).toBeTruthy();
      // No consolidation attempted
      expect(events.find(e => e.type === 'consolidation_start')).toBeFalsy();
      expect(events.find(e => e.type === 'consolidation_skip')).toBeFalsy();
      expect(wallet.consolidateVtxos).not.toHaveBeenCalled();
    });

    it('emits consolidation events in correct order', async () => {
      const vtxos = Array.from({ length: 12 }, (_, i) => fakeVtxo(1000 + i));
      const wallet = createMockWallet({
        getVtxos: vi.fn().mockResolvedValue(vtxos),
        consolidateVtxos: vi.fn().mockResolvedValue('cons-txid-abc'),
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      const types = events.map(e => e.type);
      expect(types).toEqual(['check', 'consolidation_start', 'consolidation_ok']);

      const ok = events.find(e => e.type === 'consolidation_ok');
      if (ok?.type === 'consolidation_ok') {
        expect(ok.txid).toBe('cons-txid-abc');
        expect(ok.inputCount).toBe(12);
      }
    });

    it('emits consolidation_error when consolidation fails', async () => {
      const vtxos = Array.from({ length: 12 }, (_, i) => fakeVtxo(5000 + i));
      const wallet = createMockWallet({
        getVtxos: vi.fn().mockResolvedValue(vtxos),
        consolidateVtxos: vi.fn().mockRejectedValue(new Error('settle rejected')),
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      const types = events.map(e => e.type);
      expect(types).toEqual(['check', 'consolidation_start', 'consolidation_error']);
      const err = events.find(e => e.type === 'consolidation_error');
      if (err?.type === 'consolidation_error') {
        expect(err.error).toBe('settle rejected');
      }
    });

    it('does not consolidate when no refresh error occurs but check fails', async () => {
      const wallet = createMockWallet({
        getExpiringVtxos: vi.fn().mockRejectedValue(new Error('check failed')),
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      // Error in check phase → no consolidation attempted
      expect(events.find(e => e.type === 'consolidation_start')).toBeFalsy();
      expect(events.find(e => e.type === 'consolidation_skip')).toBeFalsy();
    });

    it('only counts settled and preconfirmed VTXOs as spendable', async () => {
      const vtxos = [
        fakeVtxo(500, 'settled'),
        fakeVtxo(500, 'preconfirmed'),
        fakeVtxo(500, 'spent'),  // not spendable
      ];
      const wallet = createMockWallet({ getVtxos: vi.fn().mockResolvedValue(vtxos) });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      const check = events.find(e => e.type === 'check');
      if (check?.type === 'check') {
        expect(check.vtxoCount).toBe(2); // only settled + preconfirmed
        expect(check.dustCount).toBe(2); // both are < 1000
      }
      // 2 dust VTXOs, consolidation should trigger
      const start = events.find(e => e.type === 'consolidation_start');
      expect(start).toBeTruthy();
      if (start?.type === 'consolidation_start') {
        expect(start.vtxoCount).toBe(2);
      }
    });
  });

  describe('exponential backoff on errors', () => {
    it('tick returns true on error, false on success', async () => {
      const wallet = createMockWallet({
        getExpiringVtxos: vi.fn().mockRejectedValueOnce(new Error('Too Many Requests')),
      });
      const agent = new RefreshAgent(wallet, BASE_CONFIG);

      // First tick — error
      const hadError = await agent.tick();
      expect(hadError).toBe(true);

      // Second tick — success (mock returns empty by default after first call)
      const wallet2 = createMockWallet();
      const agent2 = new RefreshAgent(wallet2, BASE_CONFIG);
      const ok = await agent2.tick();
      expect(ok).toBe(false);
    });

    it('backs off polling interval after consecutive errors', async () => {
      let callCount = 0;
      const wallet = createMockWallet({
        getExpiringVtxos: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount <= 3) return Promise.reject(new Error('Too Many Requests'));
          return Promise.resolve([]);
        }),
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, { ...BASE_CONFIG, pollIntervalMs: 1000 }, (e) => events.push(e));

      agent.start();

      // First tick runs immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(callCount).toBe(1);

      // After error, next tick should be at 2x interval (2000ms)
      await vi.advanceTimersByTimeAsync(1000); // 1x — too early
      expect(callCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1000); // 2x — should fire
      expect(callCount).toBe(2);

      // After second error, next tick at 4x interval (4000ms)
      await vi.advanceTimersByTimeAsync(3000); // 3s — too early
      expect(callCount).toBe(2);
      await vi.advanceTimersByTimeAsync(1000); // 4s total — should fire
      expect(callCount).toBe(3);

      agent.stop();
    });

    it('resets backoff after successful tick', async () => {
      let callCount = 0;
      const wallet = createMockWallet({
        getExpiringVtxos: vi.fn().mockImplementation(() => {
          callCount++;
          // First call fails, rest succeed
          if (callCount === 1) return Promise.reject(new Error('rate limited'));
          return Promise.resolve([]);
        }),
      });
      const agent = new RefreshAgent(wallet, { ...BASE_CONFIG, pollIntervalMs: 1000 });

      agent.start();

      // First tick — error
      await vi.advanceTimersByTimeAsync(0);
      expect(callCount).toBe(1);

      // Backed-off tick at 2x (2000ms)
      await vi.advanceTimersByTimeAsync(2000);
      expect(callCount).toBe(2);

      // After success, next tick should be at 1x (1000ms) — backoff reset
      await vi.advanceTimersByTimeAsync(1000);
      expect(callCount).toBe(3);

      agent.stop();
    });

    it('caps backoff at MAX_BACKOFF_MULTIPLIER (10x)', async () => {
      let callCount = 0;
      const wallet = createMockWallet({
        getExpiringVtxos: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.reject(new Error('permanently broken'));
        }),
      });
      const agent = new RefreshAgent(wallet, { ...BASE_CONFIG, pollIntervalMs: 1000 });

      agent.start();

      // Tick 0: immediate
      await vi.advanceTimersByTimeAsync(0);
      expect(callCount).toBe(1);

      // Tick 1: 2x (2s)
      await vi.advanceTimersByTimeAsync(2000);
      expect(callCount).toBe(2);

      // Tick 2: 4x (4s)
      await vi.advanceTimersByTimeAsync(4000);
      expect(callCount).toBe(3);

      // Tick 3: 8x (8s)
      await vi.advanceTimersByTimeAsync(8000);
      expect(callCount).toBe(4);

      // Tick 4: capped at 10x (10s), not 16x
      await vi.advanceTimersByTimeAsync(10000);
      expect(callCount).toBe(5);

      // Tick 5: still capped at 10x (10s)
      await vi.advanceTimersByTimeAsync(10000);
      expect(callCount).toBe(6);

      agent.stop();
    });

    it('gateway process survives ASP 429 error storm (integration)', async () => {
      // Simulate the exact production crash: ASP returns 429 repeatedly
      let ticks = 0;
      const wallet = createMockWallet({
        getExpiringVtxos: vi.fn().mockImplementation(() => {
          ticks++;
          return Promise.reject(new Error('Failed to fetch vtxos: Too Many Requests'));
        }),
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, { ...BASE_CONFIG, pollIntervalMs: 1000 }, (e) => events.push(e));

      agent.start();

      // Run for 30 simulated seconds — agent should NOT crash
      await vi.advanceTimersByTimeAsync(30_000);

      // Agent should still be running
      expect(agent.isRunning).toBe(true);

      // Should have backed off — NOT 30 ticks (one per second)
      // With 2x backoff: ticks at 0, 2, 6, 14, 24 = ~5 ticks in 30s
      expect(ticks).toBeLessThan(10);
      expect(ticks).toBeGreaterThanOrEqual(4);

      // Every tick should have produced a refresh_error
      const errors = events.filter(e => e.type === 'refresh_error');
      expect(errors.length).toBe(ticks);

      agent.stop();
    });
  });

  describe('covenant dual-mode', () => {
    // Mock covenant config — uses fake values since unit tests don't hit Introspector
    const MOCK_COVENANT_CONFIG = {
      introspectorUrl: 'http://localhost:7073',
      covenantPkScriptHex: 'deadbeef'.repeat(4),
      vtxoScript: {} as any,  // VtxoScript mock
      refreshLeafScript: new Uint8Array([0x00, 0xd1]),
      refreshArkadeScript: new Uint8Array([0x00, 0xd1, 0x00, 0xca, 0x7b, 0x88, 0x87]),
      serverUnrollScript: {} as any,
      covenantAddress: 'tark1covenant_mock_address',
    };

    function createCovenantMockWallet(overrides: Record<string, any> = {}) {
      return {
        getExpiringVtxos: vi.fn().mockResolvedValue([]),
        renewVtxos: vi.fn().mockResolvedValue('coop-refresh-txid'),
        getVtxos: vi.fn().mockResolvedValue([]),
        consolidateVtxos: vi.fn().mockResolvedValue('coop-consolidate-txid'),
        settle: vi.fn().mockResolvedValue('wrap-txid'),
        getOnchainReserveBalance: vi.fn().mockResolvedValue(100_000),
        sdkWallet: {
          indexerProvider: {
            getVtxos: vi.fn().mockResolvedValue({ vtxos: [] }),
          },
          arkProvider: {},
        },
        ...overrides,
      } as unknown as GolemWallet;
    }

    it('no covenantConfig = pure cooperative mode (backward compat)', async () => {
      const wallet = createMockWallet();
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

      await agent.tick();

      // Should NOT emit any covenant events
      const covenantEvents = events.filter(e => e.type.startsWith('covenant_'));
      expect(covenantEvents).toHaveLength(0);
    });

    it('with covenantConfig: queries indexer for covenant VTXOs', async () => {
      const wallet = createCovenantMockWallet();
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e), undefined, MOCK_COVENANT_CONFIG);

      await agent.tick();

      expect((wallet as any).sdkWallet.indexerProvider.getVtxos).toHaveBeenCalledWith({
        scripts: [MOCK_COVENANT_CONFIG.covenantPkScriptHex],
        spendableOnly: true,
      });
    });

    it('with covenantConfig: wraps standard VTXOs when they exist', async () => {
      const standardVtxos = [fakeVtxo(10_000)];
      const wallet = createCovenantMockWallet({
        getVtxos: vi.fn().mockResolvedValue(standardVtxos),
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e), undefined, MOCK_COVENANT_CONFIG);

      await agent.tick();

      const wrapEvents = events.filter(e => e.type === 'covenant_wrap_start' || e.type === 'covenant_wrap_ok');
      expect(wrapEvents).toHaveLength(2);
      expect(wrapEvents[0].type).toBe('covenant_wrap_start');
      expect(wrapEvents[1].type).toBe('covenant_wrap_ok');
    });

    it('with covenantConfig: wrapping skips rest of tick', async () => {
      const standardVtxos = [fakeVtxo(10_000)];
      const wallet = createCovenantMockWallet({
        getVtxos: vi.fn().mockResolvedValue(standardVtxos),
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e), undefined, MOCK_COVENANT_CONFIG);

      await agent.tick();

      // No refresh or consolidation events after wrapping
      const refreshEvents = events.filter(e => e.type.includes('refresh'));
      const consolidationEvents = events.filter(e => e.type.includes('consolidation'));
      expect(refreshEvents).toHaveLength(0);
      expect(consolidationEvents).toHaveLength(0);
    });

    it('with covenantConfig: expiring covenant VTXOs trigger covenant refresh', async () => {
      const now = Date.now();
      const expiringCovVtxo = {
        txid: 'cov-expiring',
        vout: 0,
        value: 5_000,
        virtualStatus: { state: 'settled', batchExpiry: now + 60 * 60 * 1000 }, // 1 hour
      };
      const wallet = createCovenantMockWallet({
        sdkWallet: {
          indexerProvider: {
            getVtxos: vi.fn().mockResolvedValue({ vtxos: [expiringCovVtxo] }),
          },
          arkProvider: {},
        },
      });
      const events: RefreshEvent[] = [];
      // Safety margin: 2 hours — so 1-hour-out VTXO is expiring
      const config = { ...BASE_CONFIG, safetyMarginMs: 2 * 60 * 60 * 1000 };
      const agent = new RefreshAgent(wallet, config, (e) => events.push(e), undefined, MOCK_COVENANT_CONFIG);

      await agent.tick();

      const covRefresh = events.filter(e => e.type === 'covenant_refresh_start');
      expect(covRefresh).toHaveLength(1);
    });

    it('with covenantConfig: non-expiring covenant VTXOs do not trigger refresh', async () => {
      const now = Date.now();
      const safeCovVtxo = {
        txid: 'cov-safe',
        vout: 0,
        value: 5_000,
        virtualStatus: { state: 'settled', batchExpiry: now + 7 * 24 * 60 * 60 * 1000 }, // 7 days
      };
      const wallet = createCovenantMockWallet({
        sdkWallet: {
          indexerProvider: {
            getVtxos: vi.fn().mockResolvedValue({ vtxos: [safeCovVtxo] }),
          },
          arkProvider: {},
        },
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e), undefined, MOCK_COVENANT_CONFIG);

      await agent.tick();

      const covRefresh = events.filter(e => e.type === 'covenant_refresh_start');
      expect(covRefresh).toHaveLength(0);
    });

    it('with covenantConfig: covenant consolidation triggers on vtxo count', async () => {
      const covVtxos = Array.from({ length: 12 }, (_, i) => ({
        txid: `cov-${i}`,
        vout: 0,
        value: 5_000,
        virtualStatus: { state: 'settled', batchExpiry: Date.now() + 7 * 24 * 60 * 60 * 1000 },
      }));
      const wallet = createCovenantMockWallet({
        sdkWallet: {
          indexerProvider: {
            getVtxos: vi.fn().mockResolvedValue({ vtxos: covVtxos }),
          },
          arkProvider: {},
        },
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e), undefined, MOCK_COVENANT_CONFIG);

      await agent.tick();

      const covConsolidation = events.filter(e => e.type === 'covenant_consolidation_start');
      expect(covConsolidation).toHaveLength(1);
      if (covConsolidation[0]?.type === 'covenant_consolidation_start') {
        expect(covConsolidation[0].vtxoCount).toBe(12);
        expect(covConsolidation[0].totalSats).toBe(60_000);
      }
    });

    it('with covenantConfig: errors in covenant path emit covenant_*_error events', async () => {
      const standardVtxos = [fakeVtxo(10_000)];
      const wallet = createCovenantMockWallet({
        getVtxos: vi.fn().mockResolvedValue(standardVtxos),
        settle: vi.fn().mockRejectedValue(new Error('settlement failed')),
      });
      const events: RefreshEvent[] = [];
      const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e), undefined, MOCK_COVENANT_CONFIG);

      await agent.tick();

      const wrapError = events.find(e => e.type === 'covenant_wrap_error');
      expect(wrapError).toBeTruthy();
      if (wrapError?.type === 'covenant_wrap_error') {
        expect(wrapError.error).toBe('settlement failed');
      }
    });
  });
});
