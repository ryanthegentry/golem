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
});
