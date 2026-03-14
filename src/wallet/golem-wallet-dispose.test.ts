/**
 * GolemWallet.dispose() tests — verify signer key zeroing delegation.
 */

import { describe, it, expect, vi } from 'vitest';
import { getPublicKey, utils } from '@noble/secp256k1';
import { ReadOnlySigner } from '../signer/read-only-signer.js';
import { GolemWallet } from './golem-wallet.js';
import { walletConfigFromNetwork } from './config.js';
import { getNetworkConfig } from '../config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

describe('GolemWallet.dispose()', () => {
  it('dispose() exists on GolemWallet', async () => {
    const secretKey = utils.randomSecretKey();
    const pubkey = getPublicKey(secretKey, true);
    const signer = new ReadOnlySigner(pubkey);
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });
    expect(typeof wallet.dispose).toBe('function');
  }, 15_000);

  it('dispose() calls signer.dispose()', async () => {
    const secretKey = utils.randomSecretKey();
    const pubkey = getPublicKey(secretKey, true);
    const signer = new ReadOnlySigner(pubkey);
    const disposeSpy = vi.spyOn(signer, 'dispose');
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });
    wallet.dispose();
    expect(disposeSpy).toHaveBeenCalledOnce();
  }, 15_000);

  it('dispose() is idempotent', async () => {
    const secretKey = utils.randomSecretKey();
    const pubkey = getPublicKey(secretKey, true);
    const signer = new ReadOnlySigner(pubkey);
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });
    expect(() => {
      wallet.dispose();
      wallet.dispose();
    }).not.toThrow();
  }, 15_000);
});
