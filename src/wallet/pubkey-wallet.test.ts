/**
 * Pubkey-only wallet tests — receive-only GolemWallet with ReadOnlySigner.
 */

import { describe, it, expect, vi } from 'vitest';
import { getPublicKey, utils } from '@noble/secp256k1';
import { ReadOnlySigner } from '../signer/read-only-signer.js';
import { GolemWallet } from './golem-wallet.js';
import { walletConfigFromNetwork } from './config.js';
import { getNetworkConfig } from '../config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

describe('Pubkey-only wallet (Feature 1)', () => {
  it('GolemWallet with ReadOnlySigner can getAddress()', async () => {
    const secretKey = utils.randomSecretKey();
    const pubkey = getPublicKey(secretKey, true);
    const signer = new ReadOnlySigner(pubkey);

    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });

    const address = await wallet.getAddress();
    expect(address).toBeTruthy();
  }, 15_000);

  it('GolemWallet with ReadOnlySigner can getBalance()', async () => {
    const secretKey = utils.randomSecretKey();
    const pubkey = getPublicKey(secretKey, true);
    const signer = new ReadOnlySigner(pubkey);

    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });

    const balance = await wallet.getBalance();
    expect(balance.total).toBe(0);
  }, 15_000);

  it('sendBitcoin() with ReadOnlySigner throws receive-only error', async () => {
    const secretKey = utils.randomSecretKey();
    const pubkey = getPublicKey(secretKey, true);
    const signer = new ReadOnlySigner(pubkey);

    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });

    // Mock balance so we get past OOR check
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockResolvedValue({
      total: 20_000_000,
      available: 20_000_000,
      settled: 20_000_000,
      preconfirmed: 0,
      lockedInRounds: 0,
      swept: 0,
    });

    await expect(wallet.sendBitcoin({ address: 'tark1mock', amount: 100_000 }))
      .rejects.toThrow(/read-only|receive-only|no private key/i);
  }, 15_000);
});
