import { describe, it, expect, vi } from 'vitest';
import { wrapVtxoIntoCovenant } from './covenant-wrapper.js';

function createMockWallet(overrides: Record<string, any> = {}) {
  return {
    settle: vi.fn().mockResolvedValue('wrap-txid-123'),
    ...overrides,
  } as any;
}

function fakeExtendedVtxo(value: number = 10_000) {
  return {
    txid: 'deadbeef',
    vout: 0,
    value,
    virtualStatus: { state: 'settled', batchExpiry: 0 },
    status: { confirmed: true },
    tapTree: new Uint8Array(64),
    forfeitTapLeafScript: new Uint8Array(0),
    intentTapLeafScript: new Uint8Array(0),
    createdAt: new Date(),
    isUnrolled: false,
  } as any;
}

describe('wrapVtxoIntoCovenant', () => {
  it('calls wallet.settle with correct inputs and covenant address', async () => {
    const wallet = createMockWallet();
    const vtxo = fakeExtendedVtxo(15_000);
    const covenantAddress = 'tark1covenant_address_here';

    await wrapVtxoIntoCovenant(wallet, vtxo, covenantAddress);

    expect(wallet.settle).toHaveBeenCalledOnce();
    const args = wallet.settle.mock.calls[0][0];
    expect(args.inputs).toEqual([vtxo]);
    expect(args.outputs).toEqual([{ address: covenantAddress, amount: 15_000n }]);
  });

  it('passes through the txid from settle', async () => {
    const wallet = createMockWallet({ settle: vi.fn().mockResolvedValue('custom-txid') });
    const txid = await wrapVtxoIntoCovenant(wallet, fakeExtendedVtxo(), 'tark1addr');
    expect(txid).toBe('custom-txid');
  });

  it('propagates settle errors', async () => {
    const wallet = createMockWallet({
      settle: vi.fn().mockRejectedValue(new Error('settlement round failed')),
    });

    await expect(
      wrapVtxoIntoCovenant(wallet, fakeExtendedVtxo(), 'tark1addr'),
    ).rejects.toThrow('settlement round failed');
  });
});
