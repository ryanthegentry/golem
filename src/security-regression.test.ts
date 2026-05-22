/**
 * Red-team remediation tests — RC1, RC2, RC3, RC5, RC6 validation.
 *
 * RC4 (block-height expiry) has its own test file: agent/expiry-block-height.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { walletBalance } from './test/wallet-balance.js';

// --- RC1: Cumulative OOR tracking ---

describe('RC1: Cumulative OOR exposure tracking', () => {
  it('OOR limit uses preconfirmed balance for cumulative check', async () => {
    // Import dynamically to avoid module-level side effects
    const { MockSigner } = await import('./signer/mock-signer.js');
    const { GolemWallet } = await import('./wallet/golem-wallet.js');
    const { walletConfigFromNetwork } = await import('./wallet/config.js');
    const { getNetworkConfig } = await import('./config/networks.js');
    const { OorLimitExceededError } = await import('./wallet/errors.js');

    const config = walletConfigFromNetwork(getNetworkConfig('mutinynet'));
    const signer = MockSigner.create();
    const wallet = await GolemWallet.create(signer, { ...config, dataDir: null });

    // Simulate: 20M total, 1.5M already preconfirmed (unsettled OOR)
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockResolvedValue(walletBalance({
      total: 20_000_000,
      available: 18_500_000,
      settled: 18_500_000,
      preconfirmed: 1_500_000, // Already 1.5M in OOR
    }));
    vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockResolvedValue('mock-txid');

    // Limit is 10% of 20M = 2M. Already 1.5M preconfirmed.
    // 400K more → total 1.9M → should pass
    await expect(wallet.sendBitcoin({ address: 'tark1mock', amount: 400_000 }))
      .resolves.toBe('mock-txid');

    // 600K more → total 2.1M → should fail (exceeds 2M cap)
    await expect(wallet.sendBitcoin({ address: 'tark1mock', amount: 600_000 }))
      .rejects.toThrow(OorLimitExceededError);
  }, 15_000);

  it('fragmented drain attack blocked by cumulative OOR', async () => {
    const { MockSigner } = await import('./signer/mock-signer.js');
    const { GolemWallet } = await import('./wallet/golem-wallet.js');
    const { walletConfigFromNetwork } = await import('./wallet/config.js');
    const { getNetworkConfig } = await import('./config/networks.js');
    const { OorLimitExceededError } = await import('./wallet/errors.js');

    const config = walletConfigFromNetwork(getNetworkConfig('mutinynet'));
    const signer = MockSigner.create();
    const wallet = await GolemWallet.create(signer, { ...config, dataDir: null });

    // Start with 20M, preconfirmed grows with each "send"
    let preconfirmed = 0;
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockImplementation(async () => walletBalance({
      total: 20_000_000,
      available: 20_000_000 - preconfirmed,
      settled: 20_000_000 - preconfirmed,
      preconfirmed,
    }));
    vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockImplementation(async () => {
      preconfirmed += 200_000;
      return 'txid';
    });

    // Send 200K sats 10 times. Limit is 2M.
    // Sends 1-10: preconfirmed goes 0→200K→...→1.8M
    // Send 11: preconfirmed=2M, 2M + 200K > 2M → reject
    let successCount = 0;
    for (let i = 0; i < 15; i++) {
      try {
        await wallet.sendBitcoin({ address: 'tark1mock', amount: 200_000 });
        successCount++;
      } catch (err) {
        expect(err).toBeInstanceOf(OorLimitExceededError);
        break;
      }
    }
    // Should succeed ~10 times (2M / 200K), then fail
    expect(successCount).toBe(10);
  }, 15_000);
});

// --- RC3: Sensitive data in output ---

describe('RC3: No sensitive data in output', () => {
  it('pay-lightning truncates preimage', async () => {
    // Read the source file and check the log pattern
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'cli/commands/pay-lightning.ts'),
      'utf-8'
    );
    // Should use .slice(0, 8)... not the full preimage
    expect(source).toContain('result.preimage.slice(0, 8)');
    expect(source).not.toMatch(/console\.log.*\$\{result\.preimage\}`/);
  });

  it('pay-l402 truncates preimage (Ark OOR path)', async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'cli/commands/pay-l402.ts'),
      'utf-8'
    );
    // Both Lightning and Ark paths should truncate
    const preimageMatches = source.match(/\.slice\(0, 8\)/g);
    expect(preimageMatches?.length).toBeGreaterThanOrEqual(2); // At least 2 truncations
  });

  it('promptSecret uses raw mode for echo suppression', async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'cli/wallet.ts'),
      'utf-8'
    );
    expect(source).toContain('setRawMode');
  });
});

// --- RC5: Root key store cleanup ---

describe('RC5: Root key store TTL cleanup', () => {
  it('MemoryRootKeyStore cleans up expired keys', async () => {
    const { MemoryRootKeyStore } = await import('./l402/macaroon.js');
    const store = new MemoryRootKeyStore();

    const key = randomBytes(32);
    const pastExpiry = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    store.putKey('expired-id', key, pastExpiry);

    const futureExpiry = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now
    store.putKey('active-id', randomBytes(32), futureExpiry);

    const deleted = store.cleanup();
    expect(deleted).toBe(1);
    expect(store.getKey('expired-id')).toBeNull();
    expect(store.getKey('active-id')).not.toBeNull();
  });

  it('FileRootKeyStore persists and cleans up expired keys', async () => {
    const { FileRootKeyStore } = await import('./l402/macaroon.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-rc5-'));

    try {
      const store = new FileRootKeyStore(tmpDir);
      const key = randomBytes(32);
      const pastExpiry = Math.floor(Date.now() / 1000) - 7200;
      store.putKey('old-id', key, pastExpiry);
      store.putKey('new-id', randomBytes(32), Math.floor(Date.now() / 1000) + 7200);

      const deleted = store.cleanup();
      expect(deleted).toBe(1);
      expect(store.getKey('old-id')).toBeNull();
      expect(store.getKey('new-id')).not.toBeNull();

      // Reload from disk — deletion should be persisted
      const reloaded = new FileRootKeyStore(tmpDir);
      expect(reloaded.getKey('old-id')).toBeNull();
      expect(reloaded.getKey('new-id')).not.toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('mintL402Macaroon stores expiry with root key', async () => {
    const { mintL402Macaroon, MemoryRootKeyStore: MRK } = await import('./l402/macaroon.js');
    const store = new MRK();

    const paymentHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    mintL402Macaroon(store, { paymentHash, ttlSeconds: 300 });

    // Root key should exist — cleanup should NOT delete it (not expired yet)
    const deleted = store.cleanup();
    expect(deleted).toBe(0);
  });
});

// --- RC6: Wider OOR payment disambiguation ---

describe('RC6: OOR payment disambiguation', () => {
  it('Ark payment amount suffix range is 1-9999', async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'l402/gateway.ts'),
      'utf-8'
    );
    expect(source).toContain('% 9999');
    expect(source).not.toContain('% 99)');
  });
});

// --- RC2: Deployment security ---

describe('RC2: Deployment posture', () => {
  it('resolve-signer validates GOLEM_SIGNER_KEY format', async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'signer/resolve-signer.ts'),
      'utf-8'
    );
    expect(source).toContain('validateSignerKeyHex');
    expect(source).toContain('/^[0-9a-f]{64}$/i');
    expect(source).toContain('isValidSecretKey');
  });

  it('gateway-server rejects self-referencing upstream', async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'l402/gateway-server.ts'),
      'utf-8'
    );
    expect(source).toContain('self-proxy loop');
  });

  it('server binds to 127.0.0.1 when no API key', async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'server/index.ts'),
      'utf-8'
    );
    // Should default to 127.0.0.1 when no apiKey
    expect(source).toContain("apiKey ? '0.0.0.0' : '127.0.0.1'");
  });

  it('server auth-gates ALL /api/* endpoints', async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'server/index.ts'),
      'utf-8'
    );
    // Should NOT have selective auth based on path
    expect(source).not.toContain("path === '/api/send'");
    // Should have fail-closed auth for all
    expect(source).toContain('GOLEM_API_KEY required');
  });

  it('server has rate limit on /api/send', async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'server/index.ts'),
      'utf-8'
    );
    expect(source).toContain('sendRateLimit');
    expect(source).toContain('429');
  });
});
