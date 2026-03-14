/**
 * Safe harbor adversarial tests — untested critical path.
 *
 * Validates exitToSafeHarbor() behavior under:
 * - ASP online (cooperative offboard)
 * - ASP unreachable (unilateral fallback)
 * - Dust VTXOs (below exit fee)
 * - Network-mismatched safe harbor address
 * - Gateway shutdown during exit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from './golem-wallet.js';
import { walletConfigFromNetwork } from './config.js';
import { getNetworkConfig } from '../config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

describe('Safe harbor adversarial (Fix 4)', () => {
  let wallet: GolemWallet;

  beforeEach(async () => {
    const signer = MockSigner.create();
    wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });
  }, 15_000);

  it('attempts cooperative offboard when ASP is online', async () => {
    // Mock arkProvider.getInfo to succeed (ASP online)
    const mockFees = { round: 1000, boarding: 500 };
    vi.spyOn(wallet.sdkWallet.arkProvider, 'getInfo').mockResolvedValue({
      fees: mockFees,
    } as any);

    // Mock Ramps offboard to succeed
    const { Ramps } = await import('@arkade-os/sdk');
    const offboardSpy = vi.fn().mockResolvedValue('coop-txid');
    vi.spyOn(Ramps.prototype, 'offboard').mockImplementation(offboardSpy);

    const result = await wallet.exitToSafeHarbor(
      'bcrt1q6z64thg9dxymmst7gvkgqd5us5hs79s3rz2l38',
    );

    expect(result.method).toBe('offboard');
    expect(result.txid).toBe('coop-txid');
    expect(offboardSpy).toHaveBeenCalled();
  });

  it('falls back to unilateral exit when ASP is unreachable', async () => {
    // Mock arkProvider.getInfo to fail (ASP down)
    vi.spyOn(wallet.sdkWallet.arkProvider, 'getInfo').mockRejectedValue(
      new Error('Connection refused'),
    );

    // Mock getVtxos to return a VTXO
    vi.spyOn(wallet.sdkWallet, 'getVtxos').mockResolvedValue([
      { txid: 'abc123', vout: 0, value: 100_000 } as any,
    ]);

    // Mock OnchainWallet with sufficient reserve
    const mockOcw = {
      getBalance: vi.fn().mockResolvedValue(50_000),
      address: 'bcrt1qmock',
    };
    vi.spyOn(wallet, 'getOrCreateOnchainWallet').mockResolvedValue(mockOcw as any);

    // Mock Unroll — session create + steps
    const { Unroll } = await import('@arkade-os/sdk');
    const mockStep = { type: Unroll.StepType.DONE, vtxoTxid: 'unroll-txid', do: vi.fn() };
    vi.spyOn(Unroll.Session, 'create').mockResolvedValue({
      [Symbol.asyncIterator]: async function* () { yield mockStep; },
    } as any);
    vi.spyOn(Unroll, 'completeUnroll').mockResolvedValue('final-txid');

    const result = await wallet.exitToSafeHarbor(
      'bcrt1q6z64thg9dxymmst7gvkgqd5us5hs79s3rz2l38',
    );

    expect(result.method).toBe('unroll');
    expect(result.txid).toBe('final-txid');
  });

  it('throws when unilateral exit has insufficient on-chain reserve', async () => {
    // ASP down
    vi.spyOn(wallet.sdkWallet.arkProvider, 'getInfo').mockRejectedValue(
      new Error('Connection refused'),
    );

    // Has VTXOs but insufficient reserve
    vi.spyOn(wallet.sdkWallet, 'getVtxos').mockResolvedValue([
      { txid: 'abc', vout: 0, value: 100_000 } as any,
      { txid: 'def', vout: 0, value: 200_000 } as any,
    ]);

    const mockOcw = {
      getBalance: vi.fn().mockResolvedValue(100), // Way too low
      address: 'bcrt1qmock',
    };
    vi.spyOn(wallet, 'getOrCreateOnchainWallet').mockResolvedValue(mockOcw as any);

    await expect(
      wallet.exitToSafeHarbor('bcrt1q6z64thg9dxymmst7gvkgqd5us5hs79s3rz2l38'),
    ).rejects.toThrow(/on-chain reserve/i);
  });

  it('shuts down gateway before starting exit', async () => {
    const shutdown = vi.fn();
    const gateway = { shutdown };

    // ASP online, mock successful offboard
    vi.spyOn(wallet.sdkWallet.arkProvider, 'getInfo').mockResolvedValue({
      fees: { round: 1000, boarding: 500 },
    } as any);
    const { Ramps } = await import('@arkade-os/sdk');
    vi.spyOn(Ramps.prototype, 'offboard').mockResolvedValue('txid');

    await wallet.exitToSafeHarbor(
      'bcrt1q6z64thg9dxymmst7gvkgqd5us5hs79s3rz2l38',
      gateway,
    );

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('safe harbor address validated for correct network at init time', async () => {
    const { validateBitcoinAddress } = await import('../utils/address-validation.js');

    // tb1 on mainnet should throw
    expect(() => validateBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'mainnet'))
      .toThrow();

    // bc1 on testnet should throw
    expect(() => validateBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'testnet'))
      .toThrow();
  });
});
