import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RefreshAgent } from './refresh-agent.js';
import type { RefreshEvent } from './refresh-agent.js';
import type { GolemWallet } from '../wallet/golem-wallet.js';

function createMockWallet(overrides: Partial<GolemWallet> = {}): GolemWallet {
  return {
    getExpiringVtxos: vi.fn().mockResolvedValue([]),
    renewVtxos: vi.fn().mockResolvedValue('mock-txid'),
    getVtxos: vi.fn().mockResolvedValue([]),
    consolidateVtxos: vi.fn().mockResolvedValue('consolidate-txid'),
    getOnchainReserveBalance: vi.fn().mockResolvedValue(100_000),
    exitToSafeHarbor: vi.fn().mockResolvedValue({ txid: 'exit-txid', method: 'offboard' }),
    ...overrides,
  } as unknown as GolemWallet;
}

const BASE_CONFIG = {
  pollIntervalMs: 1000,
  safetyMarginMs: 60_000,
  maxVtxoCount: 10,
  dustThresholdSats: 1000,
  safeHarborExitThresholdBlocks: 432,
};

describe('RefreshAgent emergency exit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits reserve_low when on-chain reserve is insufficient', async () => {
    const events: RefreshEvent[] = [];
    const wallet = createMockWallet({
      getVtxos: vi.fn().mockResolvedValue([
        { txid: 'tx1', vout: 0, value: 10000, virtualStatus: { state: 'settled' } },
        { txid: 'tx2', vout: 0, value: 20000, virtualStatus: { state: 'settled' } },
      ]),
      getOnchainReserveBalance: vi.fn().mockResolvedValue(5_000), // Way too low
    });

    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));
    await agent.tick();

    const reserveEvent = events.find(e => e.type === 'reserve_low');
    expect(reserveEvent).toBeDefined();
    if (reserveEvent?.type === 'reserve_low') {
      expect(reserveEvent.actual).toBe(5_000);
      expect(reserveEvent.required).toBe(30_000); // 2 VTXOs × 15,000
      expect(reserveEvent.vtxoCount).toBe(2);
    }
  });

  it('does not emit reserve_low when reserve is sufficient', async () => {
    const events: RefreshEvent[] = [];
    const wallet = createMockWallet({
      getVtxos: vi.fn().mockResolvedValue([
        { txid: 'tx1', vout: 0, value: 10000, virtualStatus: { state: 'settled' } },
      ]),
      getOnchainReserveBalance: vi.fn().mockResolvedValue(50_000), // Plenty
    });

    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));
    await agent.tick();

    expect(events.find(e => e.type === 'reserve_low')).toBeUndefined();
  });

  it('does not trigger emergency exit on first refresh failure', async () => {
    const events: RefreshEvent[] = [];
    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue([
        { txid: 'tx1', vout: 0, value: 10000, virtualStatus: { state: 'settled', batchExpiry: Date.now() + 3600_000 } },
      ]),
      renewVtxos: vi.fn().mockRejectedValue(new Error('ASP unreachable')),
      getVtxos: vi.fn().mockResolvedValue([
        { txid: 'tx1', vout: 0, value: 10000, virtualStatus: { state: 'settled', batchExpiry: Date.now() + 3600_000 } },
      ]),
    });

    const config = {
      ...BASE_CONFIG,
      safeHarborAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    };

    const agent = new RefreshAgent(wallet, config, (e) => events.push(e));
    await agent.tick();

    // Should see refresh_error but NOT emergency_exit_triggered
    expect(events.find(e => e.type === 'refresh_error')).toBeDefined();
    expect(events.find(e => e.type === 'emergency_exit_triggered')).toBeUndefined();
  });

  it('triggers emergency exit when VTXOs near expiry AND refresh keeps failing', async () => {
    const events: RefreshEvent[] = [];
    const exitFn = vi.fn().mockResolvedValue({ txid: 'exit-txid', method: 'offboard' as const });

    // VTXOs with timestamp-based expiry within the 72-hour threshold
    const nearExpiry = Date.now() + (71 * 60 * 60 * 1000); // 71 hours from now (< 432 blocks × 10 min)
    const vtxos = [
      { txid: 'tx1', vout: 0, value: 50000, virtualStatus: { state: 'settled', batchExpiry: nearExpiry } },
    ];

    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(vtxos),
      renewVtxos: vi.fn().mockRejectedValue(new Error('ASP unreachable')),
      getVtxos: vi.fn().mockResolvedValue(vtxos),
      getOnchainReserveBalance: vi.fn().mockResolvedValue(50_000),
      exitToSafeHarbor: exitFn,
    });

    const config = {
      ...BASE_CONFIG,
      safeHarborAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    };

    const gateway = { shutdown: vi.fn() };
    const agent = new RefreshAgent(wallet, config, (e) => events.push(e), gateway);

    // First tick: refresh fails, sets consecutiveRefreshFailures = 1
    await agent.tick();
    expect(events.find(e => e.type === 'refresh_error')).toBeDefined();

    // Second tick: VTXOs near expiry + failures > 0 → emergency exit triggered
    events.length = 0;
    await agent.tick();

    const exitTriggered = events.find(e => e.type === 'emergency_exit_triggered');
    expect(exitTriggered).toBeDefined();

    const exitCompleted = events.find(e => e.type === 'emergency_exit_completed');
    expect(exitCompleted).toBeDefined();
    if (exitCompleted?.type === 'emergency_exit_completed') {
      expect(exitCompleted.txid).toBe('exit-txid');
      expect(exitCompleted.method).toBe('offboard');
    }

    expect(exitFn).toHaveBeenCalledWith(config.safeHarborAddress, gateway);
  });

  it('stops polling after successful emergency exit', async () => {
    const events: RefreshEvent[] = [];

    const nearExpiry = Date.now() + (71 * 60 * 60 * 1000);
    const vtxos = [
      { txid: 'tx1', vout: 0, value: 50000, virtualStatus: { state: 'settled', batchExpiry: nearExpiry } },
    ];

    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(vtxos),
      renewVtxos: vi.fn().mockRejectedValue(new Error('ASP down')),
      getVtxos: vi.fn().mockResolvedValue(vtxos),
      getOnchainReserveBalance: vi.fn().mockResolvedValue(50_000),
      exitToSafeHarbor: vi.fn().mockResolvedValue({ txid: 'exit-txid', method: 'offboard' }),
    });

    const config = {
      ...BASE_CONFIG,
      safeHarborAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    };

    const agent = new RefreshAgent(wallet, config, (e) => events.push(e));
    agent.start(); // Start so isRunning is true and stop emits 'stopped'

    // First tick: failure
    await agent.tick();
    // Second tick: emergency exit + stop
    await agent.tick();

    expect(agent.isRunning).toBe(false);
    expect(events.find(e => e.type === 'stopped')).toBeDefined();
  });

  it('keeps trying if emergency exit fails', async () => {
    const events: RefreshEvent[] = [];

    const nearExpiry = Date.now() + (71 * 60 * 60 * 1000);
    const vtxos = [
      { txid: 'tx1', vout: 0, value: 50000, virtualStatus: { state: 'settled', batchExpiry: nearExpiry } },
    ];

    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(vtxos),
      renewVtxos: vi.fn().mockRejectedValue(new Error('ASP down')),
      getVtxos: vi.fn().mockResolvedValue(vtxos),
      getOnchainReserveBalance: vi.fn().mockResolvedValue(50_000),
      exitToSafeHarbor: vi.fn().mockRejectedValue(new Error('Exit also failed')),
    });

    const config = {
      ...BASE_CONFIG,
      safeHarborAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    };

    const agent = new RefreshAgent(wallet, config, (e) => events.push(e));

    // First tick: refresh failure
    await agent.tick();
    // Second tick: emergency exit attempted but fails
    events.length = 0;
    await agent.tick();

    expect(events.find(e => e.type === 'emergency_exit_triggered')).toBeDefined();
    expect(events.find(e => e.type === 'emergency_exit_failed')).toBeDefined();

    // Emergency exit did not complete — agent should not have stopped itself
    expect(events.find(e => e.type === 'emergency_exit_completed')).toBeUndefined();
  });

  it('does not trigger emergency exit without safe harbor address', async () => {
    const events: RefreshEvent[] = [];

    const nearExpiry = Date.now() + (71 * 60 * 60 * 1000);
    const vtxos = [
      { txid: 'tx1', vout: 0, value: 50000, virtualStatus: { state: 'settled', batchExpiry: nearExpiry } },
    ];

    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(vtxos),
      renewVtxos: vi.fn().mockRejectedValue(new Error('ASP down')),
      getVtxos: vi.fn().mockResolvedValue(vtxos),
      getOnchainReserveBalance: vi.fn().mockResolvedValue(50_000),
    });

    // No safeHarborAddress in config
    const agent = new RefreshAgent(wallet, BASE_CONFIG, (e) => events.push(e));

    await agent.tick(); // failure
    await agent.tick(); // still no exit

    expect(events.find(e => e.type === 'emergency_exit_triggered')).toBeUndefined();
  });

  it('resets failure count on successful refresh', async () => {
    const events: RefreshEvent[] = [];

    // VTXOs NOT near expiry — far enough away that emergency exit doesn't trigger
    const farExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days from now
    const vtxos = [
      { txid: 'tx1', vout: 0, value: 50000, virtualStatus: { state: 'settled', batchExpiry: farExpiry } },
    ];

    const renewFn = vi.fn()
      .mockRejectedValueOnce(new Error('ASP down'))  // First call fails
      .mockResolvedValueOnce('refresh-txid');          // Second call succeeds

    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(vtxos),
      renewVtxos: renewFn,
      getVtxos: vi.fn().mockResolvedValue(vtxos),
      getOnchainReserveBalance: vi.fn().mockResolvedValue(50_000),
    });

    const config = {
      ...BASE_CONFIG,
      safeHarborAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    };

    const agent = new RefreshAgent(wallet, config, (e) => events.push(e));

    // First tick: failure (consecutiveRefreshFailures = 1)
    await agent.tick();
    expect(events.find(e => e.type === 'refresh_error')).toBeDefined();

    // Second tick: success (consecutiveRefreshFailures reset to 0)
    events.length = 0;
    await agent.tick();
    expect(events.find(e => e.type === 'refresh_ok')).toBeDefined();
    expect(events.find(e => e.type === 'emergency_exit_triggered')).toBeUndefined();

    // Third tick: if refresh fails again, should NOT trigger exit immediately
    // because failures were reset (and VTXOs are not near expiry)
    renewFn.mockRejectedValueOnce(new Error('ASP down again'));
    events.length = 0;
    await agent.tick();
    expect(events.find(e => e.type === 'emergency_exit_triggered')).toBeUndefined();
  });

  it('triggers emergency exit when VTXO batchExpiry is 47h away (inside 72h threshold)', async () => {
    const events: RefreshEvent[] = [];
    const exitFn = vi.fn().mockResolvedValue({ txid: 'exit-47h', method: 'offboard' as const });

    // 47 hours from now — well inside the 432-block (72h) threshold
    const expiry47h = Date.now() + (47 * 60 * 60 * 1000);
    const vtxos = [
      { txid: 'tx-mainnet', vout: 0, value: 2094, virtualStatus: { state: 'preconfirmed', batchExpiry: expiry47h } },
    ];

    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(vtxos),
      renewVtxos: vi.fn().mockRejectedValue(new Error('ASP unreachable')),
      getVtxos: vi.fn().mockResolvedValue(vtxos),
      getOnchainReserveBalance: vi.fn().mockResolvedValue(50_000),
      exitToSafeHarbor: exitFn,
    });

    const config = {
      ...BASE_CONFIG,
      safeHarborAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    };

    const agent = new RefreshAgent(wallet, config, (e) => events.push(e));

    // First tick: refresh fails
    await agent.tick();
    expect(events.find(e => e.type === 'refresh_error')).toBeDefined();

    // Second tick: 47h < 72h threshold + failures > 0 → emergency exit
    events.length = 0;
    await agent.tick();

    expect(events.find(e => e.type === 'emergency_exit_triggered')).toBeDefined();
    expect(events.find(e => e.type === 'emergency_exit_completed')).toBeDefined();
    expect(exitFn).toHaveBeenCalledWith(config.safeHarborAddress, undefined);
  });

  it('does NOT trigger emergency exit when VTXO batchExpiry is 80h away (outside 72h threshold)', async () => {
    const events: RefreshEvent[] = [];

    // 80 hours from now — outside the 72h threshold
    const expiry80h = Date.now() + (80 * 60 * 60 * 1000);
    const vtxos = [
      { txid: 'tx-safe', vout: 0, value: 5000, virtualStatus: { state: 'settled', batchExpiry: expiry80h } },
    ];

    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(vtxos),
      renewVtxos: vi.fn().mockRejectedValue(new Error('ASP down')),
      getVtxos: vi.fn().mockResolvedValue(vtxos),
      getOnchainReserveBalance: vi.fn().mockResolvedValue(50_000),
      exitToSafeHarbor: vi.fn().mockResolvedValue({ txid: 'should-not', method: 'offboard' }),
    });

    const config = {
      ...BASE_CONFIG,
      safeHarborAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    };

    const agent = new RefreshAgent(wallet, config, (e) => events.push(e));

    await agent.tick(); // failure 1
    await agent.tick(); // failure 2 — but 80h > 72h, no exit

    expect(events.find(e => e.type === 'emergency_exit_triggered')).toBeUndefined();
  });
});
