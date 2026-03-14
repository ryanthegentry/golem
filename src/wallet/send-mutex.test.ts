/**
 * Send mutex tests — HIGH-003: OOR race condition.
 *
 * Concurrent sendBitcoin() calls must be serialized to prevent
 * cumulative OOR limit bypass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from './golem-wallet.js';
import { walletConfigFromNetwork } from './config.js';
import { getNetworkConfig } from '../config/networks.js';
import { OorLimitExceededError } from './errors.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

describe('Send mutex (HIGH-003)', () => {
  let wallet: GolemWallet;

  beforeEach(async () => {
    const signer = MockSigner.create();
    wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });
  }, 15_000);

  it('rejects second concurrent send when cumulative exceeds cap', async () => {
    // 20M total, 10% limit = 2M. Each send is 1.5M.
    // First passes (0 + 1.5M = 1.5M ≤ 2M), second should fail (1.5M + 1.5M = 3M > 2M).
    let preconfirmed = 0;
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockImplementation(async () => ({
      total: 20_000_000,
      available: 20_000_000 - preconfirmed,
      settled: 20_000_000 - preconfirmed,
      preconfirmed,
      lockedInRounds: 0,
      swept: 0,
    }));
    vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockImplementation(async () => {
      // Simulate async delay + preconfirmed increment
      await new Promise(r => setTimeout(r, 50));
      preconfirmed += 1_500_000;
      return 'txid-1';
    });

    // Fire both concurrently
    const [result1, result2] = await Promise.allSettled([
      wallet.sendBitcoin({ address: 'tark1mock', amount: 1_500_000 }),
      wallet.sendBitcoin({ address: 'tark1mock', amount: 1_500_000 }),
    ]);

    // First should succeed, second should fail with OOR limit
    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('rejected');
    if (result2.status === 'rejected') {
      expect(result2.reason).toBeInstanceOf(OorLimitExceededError);
    }
  }, 15_000);

  it('allows sequential sends that cumulatively stay under cap', async () => {
    let preconfirmed = 0;
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockImplementation(async () => ({
      total: 20_000_000,
      available: 20_000_000 - preconfirmed,
      settled: 20_000_000 - preconfirmed,
      preconfirmed,
      lockedInRounds: 0,
      swept: 0,
    }));
    vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockImplementation(async () => {
      preconfirmed += 500_000;
      return 'txid';
    });

    // 500K + 500K = 1M, under 2M cap — both succeed
    const tx1 = await wallet.sendBitcoin({ address: 'tark1mock', amount: 500_000 });
    expect(tx1).toBe('txid');
    const tx2 = await wallet.sendBitcoin({ address: 'tark1mock', amount: 500_000 });
    expect(tx2).toBe('txid');
  }, 15_000);

  it('serializes concurrent sends (second waits for first)', async () => {
    const order: string[] = [];
    let preconfirmed = 0;

    vi.spyOn(wallet.sdkWallet, 'getBalance').mockImplementation(async () => ({
      total: 20_000_000,
      available: 20_000_000 - preconfirmed,
      settled: 20_000_000 - preconfirmed,
      preconfirmed,
      lockedInRounds: 0,
      swept: 0,
    }));
    vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockImplementation(async () => {
      order.push('send-start');
      await new Promise(r => setTimeout(r, 50));
      preconfirmed += 100_000;
      order.push('send-end');
      return 'txid';
    });

    // Fire two sends concurrently — with mutex, they should serialize
    await Promise.all([
      wallet.sendBitcoin({ address: 'tark1mock', amount: 100_000 }),
      wallet.sendBitcoin({ address: 'tark1mock', amount: 100_000 }),
    ]);

    // With serialization: start1, end1, start2, end2 (no interleaving)
    expect(order).toEqual(['send-start', 'send-end', 'send-start', 'send-end']);
  }, 15_000);
});
