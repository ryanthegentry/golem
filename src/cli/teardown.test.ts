/**
 * Central CLI teardown (issue #10).
 *
 * Every wallet-touching command used to hang after printing its output: the
 * Ark SDK opens an indexer SSE subscription inside Wallet.create(), and its
 * socket plus reconnect timers hold the event loop open. The fix is one
 * teardown, in one place, that runs for every command — and the removal of
 * the forced process.exit() calls that were both masking the hang on the pay
 * paths and skipping signer key zeroing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPublicKey, utils } from '@noble/secp256k1';
import { GolemWallet } from '../wallet/golem-wallet.js';
import {
  createWalletFromConfig,
  disposeCliResources,
  trackCliWallet,
} from './wallet.js';
import { trackSwapInstance } from '../lightning/index.js';
import { SKIP_NETWORK } from '../test/network-gate.js';

const CLI_DIR = path.dirname(new URL(import.meta.url).pathname);

function fakeWallet() {
  const signer = { dispose: vi.fn() };
  const sdkWallet = { dispose: vi.fn().mockResolvedValue(undefined) };
  return Object.assign(Object.create(GolemWallet.prototype), {
    signer,
    sdkWallet,
    disposePromise: null,
  }) as GolemWallet & { sdkWallet: { dispose: ReturnType<typeof vi.fn> } };
}

afterEach(async () => {
  // drain anything a test registered but did not dispose
  await disposeCliResources();
  vi.restoreAllMocks();
});

describe('disposeCliResources', () => {
  it('disposes every wallet handed out by createWalletFromConfig', async () => {
    const wallet = fakeWallet();
    vi.spyOn(GolemWallet, 'create').mockResolvedValue(wallet);
    const pubkey = Buffer.from(getPublicKey(utils.randomSecretKey(), true)).toString('hex');
    const handedOut = await createWalletFromConfig({ network: 'mutinynet', publicKey: pubkey } as never);
    expect(handedOut).toBe(wallet);

    await disposeCliResources();
    expect(wallet.sdkWallet.dispose).toHaveBeenCalledOnce();
  });

  it('stops every ArkadeSwaps instance created via createLightning before disposing wallets', async () => {
    const order: string[] = [];
    const lightning = { stopSwapManager: vi.fn(async () => { order.push('swap'); }) };
    const wallet = fakeWallet();
    wallet.sdkWallet.dispose.mockImplementation(async () => { order.push('wallet'); });
    trackSwapInstance(lightning as never);
    trackCliWallet(wallet);

    await disposeCliResources();
    expect(lightning.stopSwapManager).toHaveBeenCalledOnce();
    expect(order).toEqual(['swap', 'wallet']);
  });

  it('is idempotent — a second call disposes each wallet once', async () => {
    const wallet = fakeWallet();
    trackCliWallet(wallet);

    await disposeCliResources();
    await disposeCliResources();
    expect(wallet.sdkWallet.dispose).toHaveBeenCalledOnce();
  });

  it('one rejecting dispose neither throws nor strands the other wallets', async () => {
    const bad = fakeWallet();
    bad.sdkWallet.dispose.mockRejectedValue(new Error('sdk teardown failed'));
    const good = fakeWallet();
    trackCliWallet(bad);
    trackCliWallet(good);

    await expect(disposeCliResources()).resolves.toBeUndefined();
    expect(good.sdkWallet.dispose).toHaveBeenCalledOnce();
  });
});

describe('CLI exit discipline (source assertions)', () => {
  it('cli/index.ts awaits parseAsync — parse() would tear down before the command runs', () => {
    const source = fs.readFileSync(path.join(CLI_DIR, 'index.ts'), 'utf-8');
    expect(source).toMatch(/await program\.parseAsync\(\)/);
    expect(source).not.toMatch(/program\.parse\(\)/);
  });

  it('cli/index.ts tears down on the error paths too', () => {
    const source = fs.readFileSync(path.join(CLI_DIR, 'index.ts'), 'utf-8');
    const disposeCalls = source.match(/disposeCliResources\(\)/g) ?? [];
    // finally-block plus the two process-level handlers
    expect(disposeCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('the three patched pay commands contain no forced exit', () => {
    // Scoped to these three files by name: exit.ts, receive.ts, serve.ts and
    // gateway.ts depend on their process.exit calls — a tree-wide sweep
    // would re-break commands that work today.
    for (const file of ['pay-lightning.ts', 'pay-ark.ts', 'pay-l402.ts']) {
      const source = fs.readFileSync(path.join(CLI_DIR, 'commands', file), 'utf-8');
      expect(source, `${file} must not call process.exit`).not.toMatch(/process\.exit\(/);
    }
  });

  it('pay-l402 signals a non-200 authenticated retry through process.exitCode', () => {
    const source = fs.readFileSync(path.join(CLI_DIR, 'commands', 'pay-l402.ts'), 'utf-8');
    expect(source).toMatch(/process\.exitCode = authRes\.status === 200 \? 0 : 1/);
  });
});

describe.skipIf(SKIP_NETWORK)('live teardown against mutinynet', () => {
  it('a real wallet SSE subscription is released by disposeCliResources', async () => {
    const countHeld = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap' || r === 'TLSWrap').length;
    const before = countHeld();

    const { walletConfigFromNetwork } = await import('../wallet/config.js');
    const { getNetworkConfig } = await import('../config/networks.js');
    const { ReadOnlySigner } = await import('../signer/read-only-signer.js');
    const signer = new ReadOnlySigner(Buffer.from(getPublicKey(utils.randomSecretKey(), true)));
    const wallet = await GolemWallet.create(signer, {
      ...walletConfigFromNetwork(getNetworkConfig('mutinynet')),
      dataDir: null,
    });
    trackCliWallet(wallet);
    await wallet.getBalance();
    expect(countHeld()).toBeGreaterThan(before);

    await disposeCliResources();
    // give the socket close a beat to reach libuv
    await new Promise((r) => setTimeout(r, 250));
    expect(countHeld()).toBeLessThanOrEqual(before);
  }, 30_000);
});
