import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoSweep } from './auto-sweep.js';
import type { SweepConfig, SweepEvent } from './types.js';

// ---- Mock dependencies ----

interface MockWallet {
  getBalance: ReturnType<typeof vi.fn>;
}

interface MockLightning {
  sendLightningPayment: ReturnType<typeof vi.fn>;
}

function createMockWallet(available = 0): MockWallet {
  return {
    getBalance: vi.fn().mockResolvedValue({ available }),
  };
}

function createMockLightning(): MockLightning {
  return {
    sendLightningPayment: vi.fn().mockResolvedValue({ preimage: 'abc123' }),
  };
}

const DEFAULT_CONFIG: SweepConfig = {
  enabled: true,
  address: 'marty@tftc.io',
  threshold: 100_000,
  keep: 10_000,
  minSweep: 5_000,
};

// Mock address resolver — tested separately
vi.mock('./address-resolver.js', () => ({
  detectAddressType: vi.fn().mockReturnValue('lightning-address'),
  resolveToInvoice: vi.fn().mockResolvedValue({
    bolt11: 'lnbc140000n1mock',
    amountSats: 140_000,
  }),
}));

import { resolveToInvoice, detectAddressType } from './address-resolver.js';
const mockResolveToInvoice = vi.mocked(resolveToInvoice);
const mockDetectAddressType = vi.mocked(detectAddressType);

describe('AutoSweep', () => {
  let wallet: MockWallet;
  let lightning: MockLightning;
  let events: SweepEvent[];
  let onSweep: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    wallet = createMockWallet();
    lightning = createMockLightning();
    events = [];
    onSweep = vi.fn();
    onError = vi.fn();
    mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc140000n1mock', amountSats: 140_000 });
    mockDetectAddressType.mockReturnValue('lightning-address');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createSweep(configOverrides?: Partial<SweepConfig>): AutoSweep {
    return new AutoSweep(
      wallet as any,
      lightning as any,
      { ...DEFAULT_CONFIG, ...configOverrides },
      (e) => events.push(e),
      onSweep,
      onError,
    );
  }

  // ---- Lifecycle ----

  describe('lifecycle', () => {
    it('starts and stops cleanly', () => {
      const sweep = createSweep();
      expect(sweep.isRunning).toBe(false);
      sweep.start();
      expect(sweep.isRunning).toBe(true);
      sweep.stop();
      expect(sweep.isRunning).toBe(false);
      expect(events.some(e => e.type === 'stopped')).toBe(true);
    });

    it('start is idempotent', () => {
      const sweep = createSweep();
      sweep.start();
      sweep.start();
      expect(sweep.isRunning).toBe(true);
      sweep.stop();
    });

    it('polls on interval', async () => {
      wallet.getBalance.mockResolvedValue({ available: 50_000 }); // below threshold
      const sweep = createSweep();
      sweep.start(5_000);

      // Initial tick
      await vi.advanceTimersByTimeAsync(0);
      expect(wallet.getBalance).toHaveBeenCalledTimes(1);

      // After one interval
      await vi.advanceTimersByTimeAsync(5_000);
      expect(wallet.getBalance).toHaveBeenCalledTimes(2);

      // After another interval
      await vi.advanceTimersByTimeAsync(5_000);
      expect(wallet.getBalance).toHaveBeenCalledTimes(3);

      sweep.stop();

      // No more calls after stop
      await vi.advanceTimersByTimeAsync(5_000);
      expect(wallet.getBalance).toHaveBeenCalledTimes(3);
    });
  });

  // ---- Threshold logic ----

  describe('threshold logic', () => {
    it('sweeps when balance exceeds threshold: 150k balance, 100k threshold, 10k keep → sweep 140k', async () => {
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc140000n1mock', amountSats: 140_000 });

      const sweep = createSweep();
      await sweep.checkAndSweep();

      expect(mockResolveToInvoice).toHaveBeenCalledWith('marty@tftc.io', 140_000);
      expect(lightning.sendLightningPayment).toHaveBeenCalledWith({ invoice: 'lnbc140000n1mock' });
      expect(onSweep).toHaveBeenCalledWith(140_000, 'marty@tftc.io');
    });

    it('sweeps when balance is barely over threshold: 100,001 balance → sweep 90,001', async () => {
      wallet.getBalance.mockResolvedValue({ available: 100_001 });
      mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc90001n1mock', amountSats: 90_001 });

      const sweep = createSweep();
      await sweep.checkAndSweep();

      expect(mockResolveToInvoice).toHaveBeenCalledWith('marty@tftc.io', 90_001);
      expect(lightning.sendLightningPayment).toHaveBeenCalled();
    });

    it('does NOT sweep when balance equals threshold exactly', async () => {
      wallet.getBalance.mockResolvedValue({ available: 100_000 });
      const sweep = createSweep();
      await sweep.checkAndSweep();

      expect(mockResolveToInvoice).not.toHaveBeenCalled();
      expect(lightning.sendLightningPayment).not.toHaveBeenCalled();
      expect(events.some(e => e.type === 'sweep_skip')).toBe(true);
    });

    it('does NOT sweep when balance is below threshold', async () => {
      wallet.getBalance.mockResolvedValue({ available: 50_000 });
      const sweep = createSweep();
      await sweep.checkAndSweep();

      expect(mockResolveToInvoice).not.toHaveBeenCalled();
      expect(events.some(e => e.type === 'sweep_skip')).toBe(true);
    });

    it('does NOT sweep when sweep amount is below minSweep', async () => {
      // 115k balance, 100k threshold, 10k keep → sweep amount = 105k
      // minSweep = 200k → 105k < 200k → skip
      wallet.getBalance.mockResolvedValue({ available: 115_000 });
      const sweep = createSweep({ minSweep: 200_000 });
      await sweep.checkAndSweep();

      expect(mockResolveToInvoice).not.toHaveBeenCalled();
      expect(events.some(e => e.type === 'sweep_skip' && e.reason.includes('below minimum'))).toBe(true);
    });

    it('sweeps when sweep amount meets minSweep', async () => {
      // 115k balance, 100k threshold, 10k keep → sweep amount = 105k
      // minSweep = 5k → 105k >= 5k → sweep
      wallet.getBalance.mockResolvedValue({ available: 115_000 });
      mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc105000n1mock', amountSats: 105_000 });

      const sweep = createSweep();
      await sweep.checkAndSweep();

      expect(mockResolveToInvoice).toHaveBeenCalledWith('marty@tftc.io', 105_000);
      expect(lightning.sendLightningPayment).toHaveBeenCalled();
    });
  });

  // ---- Cooldown ----

  describe('cooldown', () => {
    it('skips sweep within 10 min cooldown after successful sweep', async () => {
      // First sweep succeeds
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc140000n1first', amountSats: 140_000 });
      const sweep = createSweep();
      await sweep.checkAndSweep();
      expect(lightning.sendLightningPayment).toHaveBeenCalledTimes(1);

      // Balance back above threshold, but within cooldown
      vi.advanceTimersByTime(5 * 60 * 1000); // 5 minutes
      wallet.getBalance.mockResolvedValue({ available: 200_000 });
      await sweep.checkAndSweep();
      expect(lightning.sendLightningPayment).toHaveBeenCalledTimes(1); // no new call
      expect(events.some(e => e.type === 'sweep_skip' && e.reason.includes('cooldown'))).toBe(true);
    });

    it('sweeps again after cooldown expires', async () => {
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc140000n1first', amountSats: 140_000 });
      const sweep = createSweep();
      await sweep.checkAndSweep();
      expect(lightning.sendLightningPayment).toHaveBeenCalledTimes(1);

      // Advance past cooldown (10 minutes)
      vi.advanceTimersByTime(11 * 60 * 1000);
      wallet.getBalance.mockResolvedValue({ available: 200_000 });
      mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc190000n1second', amountSats: 190_000 });
      await sweep.checkAndSweep();
      expect(lightning.sendLightningPayment).toHaveBeenCalledTimes(2);
    });

    it('does NOT apply cooldown after failed sweep (retry immediately)', async () => {
      // First sweep fails
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      mockResolveToInvoice.mockRejectedValueOnce(new Error('DNS failure'));
      const sweep = createSweep();
      await sweep.checkAndSweep();
      expect(onError).toHaveBeenCalled();

      // Retry immediately — should attempt sweep again
      mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc140000n1retry', amountSats: 140_000 });
      await sweep.checkAndSweep();
      expect(lightning.sendLightningPayment).toHaveBeenCalledTimes(1);
    });
  });

  // ---- LNURL bounds interaction ----

  describe('LNURL bounds', () => {
    it('uses clamped amount from resolver when LNURL maxSendable is lower', async () => {
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      // Resolver clamps to 50k (maxSendable = 50k sats)
      mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc50000n1clamped', amountSats: 50_000 });

      const sweep = createSweep();
      await sweep.checkAndSweep();

      // Payment should use the clamped amount's invoice
      expect(lightning.sendLightningPayment).toHaveBeenCalledWith({ invoice: 'lnbc50000n1clamped' });
      expect(onSweep).toHaveBeenCalledWith(50_000, 'marty@tftc.io');
    });

    it('skips sweep when resolver throws minSendable error', async () => {
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      mockResolveToInvoice.mockRejectedValueOnce(new Error('below minimum 200000 sats'));

      const sweep = createSweep();
      await sweep.checkAndSweep();

      expect(lightning.sendLightningPayment).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalled();
    });
  });

  // ---- Error handling ----

  describe('error handling', () => {
    it('catches address resolution failure and notifies', async () => {
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      mockResolveToInvoice.mockRejectedValueOnce(new Error('LNURL endpoint returned HTTP 404'));

      const sweep = createSweep();
      await sweep.checkAndSweep();

      expect(lightning.sendLightningPayment).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('404'));
      expect(events.some(e => e.type === 'sweep_error')).toBe(true);
    });

    it('catches Lightning payment failure and notifies', async () => {
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      lightning.sendLightningPayment.mockRejectedValueOnce(new Error('insufficient liquidity'));

      const sweep = createSweep();
      await sweep.checkAndSweep();

      expect(onError).toHaveBeenCalledWith(expect.stringContaining('insufficient liquidity'));
      expect(events.some(e => e.type === 'sweep_error')).toBe(true);
    });

    it('catches wallet balance check failure', async () => {
      wallet.getBalance.mockRejectedValueOnce(new Error('Ark server unreachable'));

      const sweep = createSweep();
      await sweep.checkAndSweep();

      expect(mockResolveToInvoice).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('Ark server unreachable'));
    });

    it('re-checks balance before executing sweep (race condition guard)', async () => {
      // First balance check: 150k → triggers sweep
      // Second balance check (re-check): dropped to 50k → abort
      wallet.getBalance
        .mockResolvedValueOnce({ available: 150_000 })
        .mockResolvedValueOnce({ available: 50_000 });

      const sweep = createSweep();
      await sweep.checkAndSweep();

      // Balance re-check shows it dropped below threshold
      expect(lightning.sendLightningPayment).not.toHaveBeenCalled();
      expect(events.some(e => e.type === 'sweep_skip' && e.reason.includes('changed'))).toBe(true);
    });

    it('never crashes — errors are caught and logged', async () => {
      wallet.getBalance.mockRejectedValue(new Error('total crash'));

      const sweep = createSweep();

      // Should not throw
      await expect(sweep.checkAndSweep()).resolves.toBeUndefined();
    });
  });

  // ---- Events ----

  describe('events', () => {
    it('emits check event on every cycle', async () => {
      wallet.getBalance.mockResolvedValue({ available: 50_000 });
      const sweep = createSweep();
      await sweep.checkAndSweep();

      const check = events.find(e => e.type === 'check');
      expect(check).toBeTruthy();
      if (check?.type === 'check') {
        expect(check.balance).toBe(50_000);
        expect(check.threshold).toBe(100_000);
      }
    });

    it('emits sweep_start and sweep_ok on successful sweep', async () => {
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      mockResolveToInvoice.mockResolvedValue({ bolt11: 'lnbc140000n1mock', amountSats: 140_000 });

      const sweep = createSweep();
      await sweep.checkAndSweep();

      const types = events.map(e => e.type);
      expect(types).toContain('check');
      expect(types).toContain('sweep_start');
      expect(types).toContain('sweep_ok');

      const ok = events.find(e => e.type === 'sweep_ok');
      if (ok?.type === 'sweep_ok') {
        expect(ok.amount).toBe(140_000);
        expect(ok.destination).toBe('marty@tftc.io');
        expect(ok.preimage).toBe('abc123');
      }
    });

    it('emits sweep_error on failure', async () => {
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      mockResolveToInvoice.mockRejectedValueOnce(new Error('resolve failed'));

      const sweep = createSweep();
      await sweep.checkAndSweep();

      const err = events.find(e => e.type === 'sweep_error');
      expect(err).toBeTruthy();
      if (err?.type === 'sweep_error') {
        expect(err.error).toContain('resolve failed');
      }
    });

    it('all events have timestamps', async () => {
      wallet.getBalance.mockResolvedValue({ available: 150_000 });
      const sweep = createSweep();
      await sweep.checkAndSweep();

      for (const event of events) {
        expect(event.timestamp).toBeDefined();
        expect(new Date(event.timestamp).getTime()).not.toBeNaN();
      }
    });
  });

  // ---- Config validation ----

  describe('config validation', () => {
    it('validateConfig returns null for valid config', () => {
      expect(AutoSweep.validateConfig(DEFAULT_CONFIG)).toBeNull();
    });

    it('validateConfig returns error for invalid address', () => {
      mockDetectAddressType.mockImplementationOnce(() => { throw new Error('bad'); });
      const err = AutoSweep.validateConfig({ ...DEFAULT_CONFIG, address: 'garbage' });
      expect(err).toBeTruthy();
    });

    it('validateConfig returns error when threshold <= keep', () => {
      const err = AutoSweep.validateConfig({ ...DEFAULT_CONFIG, threshold: 5000, keep: 10000 });
      expect(err).toContain('threshold must be greater than keep');
    });
  });
});
