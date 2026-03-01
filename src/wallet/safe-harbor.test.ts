import { describe, it, expect, vi, beforeAll } from 'vitest';
import { utils } from '@noble/secp256k1';
import { GolemWallet } from './golem-wallet.js';
import { MockSigner } from '../signer/mock-signer.js';
import { walletConfigFromNetwork } from './config.js';
import { getNetworkConfig } from '../config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

/**
 * Safe harbor tests using a real GolemWallet connected to mutinynet.
 *
 * These tests validate that exitToSafeHarbor() calls the right SDK methods
 * in the right order. They don't test live exit (requires funded wallet).
 */

describe('GolemWallet safe harbor', () => {
  let wallet: GolemWallet;

  // Create a real wallet connected to mutinynet (zero balance)
  beforeAll(async () => {
    const signer = MockSigner.fromSecretKey(utils.randomSecretKey());
    wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null, // in-memory
    });
  }, 15_000);

  it('getRequiredReserve returns zero for empty wallet', async () => {
    const reserve = await wallet.getRequiredReserve();
    expect(reserve.vtxoCount).toBe(0);
    expect(reserve.required).toBe(0);
    expect(reserve.perVtxo).toBe(15_000);
  });

  it('getOnchainReserveBalance returns zero for unfunded wallet', async () => {
    const balance = await wallet.getOnchainReserveBalance();
    expect(balance).toBe(0);
  });

  it('getOrCreateOnchainWallet returns OnchainWallet with address', async () => {
    const ocw = await wallet.getOrCreateOnchainWallet();
    expect(ocw.address).toBeTruthy();
    expect(typeof ocw.address).toBe('string');
    expect(ocw.address.length).toBeGreaterThan(10);
  });

  it('getOrCreateOnchainWallet returns same instance on second call', async () => {
    const ocw1 = await wallet.getOrCreateOnchainWallet();
    const ocw2 = await wallet.getOrCreateOnchainWallet();
    expect(ocw1).toBe(ocw2);
  });

  it('exitToSafeHarbor shuts down gateway before exiting', async () => {
    const shutdown = vi.fn();
    const gateway = { shutdown };

    // Will fail (no VTXOs to exit), but should call shutdown first
    try {
      await wallet.exitToSafeHarbor(
        'bcrt1q6z64thg9dxymmst7gvkgqd5us5hs79s3rz2l38',
        gateway,
      );
    } catch {
      // Expected — offboard fails on empty wallet, unroll fails too
    }

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('exitToSafeHarbor attempts cooperative offboard first', async () => {
    // Spy on the SDK wallet's arkProvider to verify offboard is attempted
    const getInfoSpy = vi.spyOn(wallet.sdkWallet.arkProvider, 'getInfo');

    try {
      await wallet.exitToSafeHarbor(
        'bcrt1q6z64thg9dxymmst7gvkgqd5us5hs79s3rz2l38',
      );
    } catch {
      // Expected — empty wallet
    }

    // getInfo is called as part of the cooperative offboard attempt
    expect(getInfoSpy).toHaveBeenCalled();
    getInfoSpy.mockRestore();
  });
});
