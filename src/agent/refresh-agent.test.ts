import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RefreshAgent } from './refresh-agent.js';
import type { RefreshEvent } from './refresh-agent.js';
import type { GolemWallet } from '../wallet/golem-wallet.js';

function createMockWallet(overrides: Partial<GolemWallet> = {}): GolemWallet {
  return {
    getExpiringVtxos: vi.fn().mockResolvedValue([]),
    renewVtxos: vi.fn().mockResolvedValue('mock-txid-123'),
    ...overrides,
  } as unknown as GolemWallet;
}

describe('RefreshAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and stops cleanly', () => {
    const wallet = createMockWallet();
    const agent = new RefreshAgent(wallet, { pollIntervalMs: 1000, safetyMarginMs: 60_000 });

    expect(agent.isRunning).toBe(false);
    agent.start();
    expect(agent.isRunning).toBe(true);
    agent.stop();
    expect(agent.isRunning).toBe(false);
  });

  it('start is idempotent', () => {
    const wallet = createMockWallet();
    const agent = new RefreshAgent(wallet, { pollIntervalMs: 1000, safetyMarginMs: 60_000 });

    agent.start();
    agent.start(); // should not create duplicate timers
    expect(agent.isRunning).toBe(true);
    agent.stop();
  });

  it('emits check event with zero expiring VTXOs', async () => {
    const wallet = createMockWallet();
    const events: RefreshEvent[] = [];
    const agent = new RefreshAgent(
      wallet,
      { pollIntervalMs: 1000, safetyMarginMs: 60_000 },
      (e) => events.push(e),
    );

    await agent.tick();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('check');
    if (events[0].type === 'check') {
      expect(events[0].expiringCount).toBe(0);
    }
  });

  it('triggers renewal when VTXOs are expiring', async () => {
    const fakeVtxos = [{ txid: 'abc', vout: 0 }];
    const wallet = createMockWallet({
      getExpiringVtxos: vi.fn().mockResolvedValue(fakeVtxos),
      renewVtxos: vi.fn().mockResolvedValue('renewed-txid-456'),
    });
    const events: RefreshEvent[] = [];
    const agent = new RefreshAgent(
      wallet,
      { pollIntervalMs: 1000, safetyMarginMs: 60_000 },
      (e) => events.push(e),
    );

    await agent.tick();

    expect(events).toHaveLength(3);
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
    const agent = new RefreshAgent(
      wallet,
      { pollIntervalMs: 1000, safetyMarginMs: 60_000 },
      (e) => events.push(e),
    );

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
    const agent = new RefreshAgent(
      wallet,
      { pollIntervalMs: 1000, safetyMarginMs: 60_000 },
      (e) => events.push(e),
    );

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
    const agent = new RefreshAgent(
      wallet,
      { pollIntervalMs: 1000, safetyMarginMs: 60_000 },
      (e) => events.push(e),
    );

    agent.start();
    agent.stop();

    const stopped = events.find((e) => e.type === 'stopped');
    expect(stopped).toBeTruthy();
  });

  it('polls on interval', async () => {
    const wallet = createMockWallet();
    const agent = new RefreshAgent(
      wallet,
      { pollIntervalMs: 5000, safetyMarginMs: 60_000 },
    );

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
});
