import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GolemLightning } from './golem-lightning.js';
import type { LightningInvoice } from './golem-lightning.js';
import type { GolemWallet } from '../wallet/golem-wallet.js';
import type { GolemLightningConfig } from './config.js';

// --- Mocks ---

vi.mock('@arkade-os/boltz-swap', () => {
  const mockCreateLightningInvoice = vi.fn();
  const mockWaitAndClaim = vi.fn();
  const mockSendLightningPayment = vi.fn();
  const mockGetLimits = vi.fn();
  const mockGetFees = vi.fn();
  const mockDispose = vi.fn();

  // Must use function syntax (not arrows) so `new` works
  const BoltzSwapProvider = vi.fn(function (this: any) {
    return this;
  });
  const ArkadeLightning = vi.fn(function (this: any) {
    this.createLightningInvoice = mockCreateLightningInvoice;
    this.waitAndClaim = mockWaitAndClaim;
    this.sendLightningPayment = mockSendLightningPayment;
    this.getLimits = mockGetLimits;
    this.getFees = mockGetFees;
    this.dispose = mockDispose;
    return this;
  });

  return {
    BoltzSwapProvider,
    ArkadeLightning,
    // Re-export the mock functions so tests can configure them
    __mocks: {
      createLightningInvoice: mockCreateLightningInvoice,
      waitAndClaim: mockWaitAndClaim,
      sendLightningPayment: mockSendLightningPayment,
      getLimits: mockGetLimits,
      getFees: mockGetFees,
      dispose: mockDispose,
    },
  };
});

// Access mock functions
async function getMocks() {
  const mod = await import('@arkade-os/boltz-swap') as any;
  return mod.__mocks as {
    createLightningInvoice: ReturnType<typeof vi.fn>;
    waitAndClaim: ReturnType<typeof vi.fn>;
    sendLightningPayment: ReturnType<typeof vi.fn>;
    getLimits: ReturnType<typeof vi.fn>;
    getFees: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

const TEST_CONFIG: GolemLightningConfig = {
  boltzApiUrl: 'https://api.boltz.test',
  network: 'mutinynet',
  referralId: 'test',
};

function createMockWallet(): GolemWallet {
  return { sdkWallet: {} } as unknown as GolemWallet;
}

describe('GolemLightning', () => {
  let lightning: GolemLightning;
  let mocks: Awaited<ReturnType<typeof getMocks>>;

  beforeEach(async () => {
    mocks = await getMocks();
    // Reset all mocks between tests
    Object.values(mocks).forEach((fn) => fn.mockReset());
    lightning = new GolemLightning(createMockWallet(), TEST_CONFIG);
  });

  describe('createInvoice', () => {
    it('returns a LightningInvoice with all fields mapped', async () => {
      mocks.createLightningInvoice.mockResolvedValue({
        invoice: 'lnbcrt100n1ptest...',
        amount: 10000,
        paymentHash: 'abc123def456',
        expiry: 1700000000,
        preimage: 'preimage-hex',
        pendingSwap: {
          id: 'swap-001',
          type: 'reverse',
          createdAt: 1699999000,
          preimage: 'preimage-hex',
          status: 'swap.created',
          request: {},
          response: {},
        },
      });

      const invoice = await lightning.createInvoice(10000);

      expect(invoice.bolt11).toBe('lnbcrt100n1ptest...');
      expect(invoice.amountSats).toBe(10000);
      expect(invoice.paymentHash).toBe('abc123def456');
      expect(invoice.expiresAt).toBe(1700000000);
      expect(invoice.swapId).toBe('swap-001');
      expect(invoice.pendingSwap).toBeDefined();
      expect(invoice.pendingSwap.type).toBe('reverse');

      expect(mocks.createLightningInvoice).toHaveBeenCalledWith({ amount: 10000 });
    });

    it('propagates errors from ArkadeLightning', async () => {
      mocks.createLightningInvoice.mockRejectedValue(
        new Error('Amount below minimum'),
      );

      await expect(lightning.createInvoice(1)).rejects.toThrow('Amount below minimum');
    });
  });

  describe('waitAndClaim', () => {
    it('resolves with txid on successful claim', async () => {
      mocks.waitAndClaim.mockResolvedValue({ txid: 'claim-txid-789' });

      const invoice: LightningInvoice = {
        bolt11: 'lnbcrt100n1p...',
        amountSats: 10000,
        paymentHash: 'abc123',
        expiresAt: 1700000000,
        swapId: 'swap-001',
        pendingSwap: {
          id: 'swap-001',
          type: 'reverse',
          createdAt: 1699999000,
          preimage: 'preimage-hex',
          status: 'swap.created',
          request: {},
          response: {},
        } as any,
      };

      const result = await lightning.waitAndClaim(invoice);

      expect(result.txid).toBe('claim-txid-789');
      expect(mocks.waitAndClaim).toHaveBeenCalledWith(invoice.pendingSwap);
    });

    it('propagates errors when payment fails', async () => {
      mocks.waitAndClaim.mockRejectedValue(new Error('Invoice expired'));

      const invoice: LightningInvoice = {
        bolt11: 'lnbcrt100n1p...',
        amountSats: 10000,
        paymentHash: 'abc123',
        expiresAt: 1700000000,
        swapId: 'swap-001',
        pendingSwap: { id: 'swap-001' } as any,
      };

      await expect(lightning.waitAndClaim(invoice)).rejects.toThrow('Invoice expired');
    });
  });

  describe('payInvoice', () => {
    it('resolves with txid and preimage', async () => {
      mocks.sendLightningPayment.mockResolvedValue({
        txid: 'sub-txid-456',
        preimage: 'payment-preimage-hex',
        amount: 50000,
      });

      const result = await lightning.payInvoice('lnbcrt500n1ptest...');

      expect(result.txid).toBe('sub-txid-456');
      expect(result.preimage).toBe('payment-preimage-hex');
      expect(mocks.sendLightningPayment).toHaveBeenCalledWith({
        invoice: 'lnbcrt500n1ptest...',
      });
    });

    it('propagates errors when payment fails', async () => {
      mocks.sendLightningPayment.mockRejectedValue(
        new Error('Insufficient funds'),
      );

      await expect(lightning.payInvoice('lnbcrt1p...')).rejects.toThrow(
        'Insufficient funds',
      );
    });
  });

  describe('getLimits', () => {
    it('returns min and max', async () => {
      mocks.getLimits.mockResolvedValue({ min: 1000, max: 25000000 });

      const limits = await lightning.getLimits();

      expect(limits.min).toBe(1000);
      expect(limits.max).toBe(25000000);
    });
  });

  describe('getFees', () => {
    it('returns Boltz fee structure', async () => {
      const fees = {
        submarine: { percentage: 0.1, minerFees: 147 },
        reverse: { percentage: 0.5, minerFees: { lockup: 152, claim: 138 } },
      };
      mocks.getFees.mockResolvedValue(fees);

      const result = await lightning.getFees();

      expect(result.submarine.percentage).toBe(0.1);
      expect(result.reverse.percentage).toBe(0.5);
      expect(result.reverse.minerFees.claim).toBe(138);
    });
  });

  describe('dispose', () => {
    it('calls dispose on ArkadeLightning', async () => {
      mocks.dispose.mockResolvedValue(undefined);

      await lightning.dispose();

      expect(mocks.dispose).toHaveBeenCalledOnce();
    });
  });
});
