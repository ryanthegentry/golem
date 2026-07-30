/**
 * GolemWallet.dispose() tests — verify signer key zeroing delegation.
 */

import { describe, it, expect, vi } from 'vitest';
import { getPublicKey, utils } from '@noble/secp256k1';
import { ReadOnlySigner } from '../signer/read-only-signer.js';
import { GolemWallet } from './golem-wallet.js';
import { walletConfigFromNetwork } from './config.js';
import { getNetworkConfig } from '../config/networks.js';
import { SKIP_NETWORK } from '../test/network-gate.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

describe.skipIf(SKIP_NETWORK)('GolemWallet.dispose()', () => {
  it('dispose() exists on GolemWallet', async () => {
    const secretKey = utils.randomSecretKey();
    const pubkey = getPublicKey(secretKey, true);
    const signer = new ReadOnlySigner(pubkey);
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });
    expect(typeof wallet.dispose).toBe('function');
    await wallet.dispose(); // even here: an undisposed real wallet wedges the fork
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
    await wallet.dispose();
    expect(disposeSpy).toHaveBeenCalledOnce();
  }, 15_000);

  it('dispose() tears down the SDK wallet watcher/resources', async () => {
    const signer = { dispose: vi.fn() };
    const sdkWallet = { dispose: vi.fn().mockResolvedValue(undefined) };
    const wallet = Object.assign(Object.create(GolemWallet.prototype), {
      signer,
      sdkWallet,
      vtxoManager: { dispose: vi.fn().mockResolvedValue(undefined) },
      disposePromise: null,
    }) as GolemWallet;

    await wallet.dispose();

    expect(signer.dispose).toHaveBeenCalledOnce();
    expect(sdkWallet.dispose).toHaveBeenCalledOnce();
  });

  it('dispose() also disposes the VtxoManager — its poll timers and contract-events subscription are a second event-loop holder (#10)', async () => {
    const signer = { dispose: vi.fn() };
    const sdkWallet = { dispose: vi.fn().mockResolvedValue(undefined) };
    const vtxoManager = { dispose: vi.fn().mockResolvedValue(undefined) };
    const wallet = Object.assign(Object.create(GolemWallet.prototype), {
      signer,
      sdkWallet,
      vtxoManager,
      disposePromise: null,
    }) as GolemWallet;

    await wallet.dispose();
    expect(vtxoManager.dispose).toHaveBeenCalledOnce();
    expect(sdkWallet.dispose).toHaveBeenCalledOnce();
  });

  it('a failing VtxoManager dispose does not block SDK/socket teardown', async () => {
    const signer = { dispose: vi.fn() };
    const sdkWallet = { dispose: vi.fn().mockResolvedValue(undefined) };
    const vtxoManager = { dispose: vi.fn().mockRejectedValue(new Error('poller teardown failed')) };
    const wallet = Object.assign(Object.create(GolemWallet.prototype), {
      signer,
      sdkWallet,
      vtxoManager,
      disposePromise: null,
    }) as GolemWallet;

    await expect(wallet.dispose()).resolves.toBeUndefined();
    expect(sdkWallet.dispose).toHaveBeenCalledOnce();
  });

  it('dispose() zeroes signer key material synchronously before async SDK teardown', async () => {
    const signer = { dispose: vi.fn() };
    let resolveSdkDispose!: () => void;
    const sdkWallet = {
      dispose: vi.fn(() => new Promise<void>(resolve => {
        resolveSdkDispose = resolve;
      })),
    };
    const wallet = Object.assign(Object.create(GolemWallet.prototype), {
      signer,
      sdkWallet,
      vtxoManager: { dispose: vi.fn().mockResolvedValue(undefined) },
      disposePromise: null,
    }) as GolemWallet;

    const disposePromise = wallet.dispose();

    // the security contract: key zeroing is synchronous, before any await
    expect(signer.dispose).toHaveBeenCalledOnce();
    // SDK teardown starts after the VtxoManager poller has stopped (#10),
    // so it begins a microtask later, not in the same tick
    await Promise.resolve();
    await Promise.resolve();
    expect(sdkWallet.dispose).toHaveBeenCalledOnce();
    resolveSdkDispose();
    return disposePromise;
  });

  it('dispose() still zeroes signer key material when sdkWallet.dispose() rejects', async () => {
    const signer = { dispose: vi.fn() };
    const sdkWallet = { dispose: vi.fn().mockRejectedValue(new Error('sdk teardown failed')) };
    const wallet = Object.assign(Object.create(GolemWallet.prototype), {
      signer,
      sdkWallet,
      vtxoManager: { dispose: vi.fn().mockResolvedValue(undefined) },
      disposePromise: null,
    }) as GolemWallet;

    await expect(wallet.dispose()).rejects.toThrow('sdk teardown failed');
    expect(signer.dispose).toHaveBeenCalledOnce();

    // Retry-on-error: the next call should attempt sdkWallet.dispose() again
    sdkWallet.dispose.mockResolvedValueOnce(undefined);
    await expect(wallet.dispose()).resolves.toBeUndefined();
    expect(sdkWallet.dispose).toHaveBeenCalledTimes(2);
  });

  it('dispose() is idempotent', async () => {
    const secretKey = utils.randomSecretKey();
    const pubkey = getPublicKey(secretKey, true);
    const signer = new ReadOnlySigner(pubkey);
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });
    await expect(Promise.all([
      wallet.dispose(),
      wallet.dispose(),
    ])).resolves.toEqual([undefined, undefined]);
  }, 15_000);
});
