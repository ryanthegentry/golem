import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from './golem-wallet.js';
import { walletConfigFromNetwork } from './config.js';
import { getNetworkConfig } from '../config/networks.js';
import { OorLimitExceededError } from './errors.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

/**
 * OOR limit enforcement tests.
 * These connect to the live mutinynet Ark server (for wallet creation)
 * but mock getBalance/sendBitcoin to test limit logic without funds.
 */
describe('OOR exposure limits', () => {
  let wallet: GolemWallet;

  beforeEach(async () => {
    const signer = MockSigner.create();
    wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });
  }, 15_000);

  it('sendBitcoin succeeds when amount is under the limit', async () => {
    // Large balance: 20M sats. 10% = 2M. Send 1M → under limit.
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockResolvedValue({
      total: 20_000_000,
      available: 20_000_000,
      settled: 20_000_000,
      preconfirmed: 0,
      lockedInRounds: 0,
      swept: 0,
    });
    const sendSpy = vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockResolvedValue('mock-txid-123');

    const txid = await wallet.sendBitcoin({ address: 'tark1mockaddress', amount: 1_000_000 });
    expect(txid).toBe('mock-txid-123');
    expect(sendSpy).toHaveBeenCalledWith({ address: 'tark1mockaddress', amount: 1_000_000 });
  }, 15_000);

  it('sendBitcoin throws OorLimitExceededError when amount exceeds limit', async () => {
    // Large balance: 20M sats. 10% = 2M. Send 3M → over limit.
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockResolvedValue({
      total: 20_000_000,
      available: 20_000_000,
      settled: 20_000_000,
      preconfirmed: 0,
      lockedInRounds: 0,
      swept: 0,
    });
    const sendSpy = vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockResolvedValue('should-not-reach');

    await expect(wallet.sendBitcoin({ address: 'tark1mockaddress', amount: 3_000_000 }))
      .rejects.toThrow(OorLimitExceededError);
    expect(sendSpy).not.toHaveBeenCalled();
  }, 15_000);

  it('large balance: 10% fraction is the effective limit', async () => {
    // 50M sats. 10% = 5M > 1M floor. Limit = 5M.
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockResolvedValue({
      total: 50_000_000,
      available: 50_000_000,
      settled: 50_000_000,
      preconfirmed: 0,
      lockedInRounds: 0,
      swept: 0,
    });
    vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockResolvedValue('txid');

    // 5M exactly → should succeed (not strictly greater)
    await expect(wallet.sendBitcoin({ address: 'tark1mock', amount: 5_000_000 }))
      .resolves.toBe('txid');

    // 5_000_001 → should fail
    await expect(wallet.sendBitcoin({ address: 'tark1mock', amount: 5_000_001 }))
      .rejects.toThrow(OorLimitExceededError);
  }, 15_000);

  it('small balance: 1M floor is the effective limit', async () => {
    // 5M sats. 10% = 500K < 1M floor. Limit = 1M.
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockResolvedValue({
      total: 5_000_000,
      available: 5_000_000,
      settled: 5_000_000,
      preconfirmed: 0,
      lockedInRounds: 0,
      swept: 0,
    });
    vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockResolvedValue('txid');

    // 1M exactly → should succeed
    await expect(wallet.sendBitcoin({ address: 'tark1mock', amount: 1_000_000 }))
      .resolves.toBe('txid');

    // 1_000_001 → should fail
    await expect(wallet.sendBitcoin({ address: 'tark1mock', amount: 1_000_001 }))
      .rejects.toThrow(OorLimitExceededError);
  }, 15_000);

  it('zero balance: floor of 1M still applies', async () => {
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockResolvedValue({
      total: 0,
      available: 0,
      settled: 0,
      preconfirmed: 0,
      lockedInRounds: 0,
      swept: 0,
    });
    vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockResolvedValue('txid');

    // Under floor → should succeed (SDK will fail for other reasons, but limit passes)
    await expect(wallet.sendBitcoin({ address: 'tark1mock', amount: 500_000 }))
      .resolves.toBe('txid');

    // Over floor → should fail
    await expect(wallet.sendBitcoin({ address: 'tark1mock', amount: 1_000_001 }))
      .rejects.toThrow(OorLimitExceededError);
  }, 15_000);

  it('custom config overrides fraction and floor', async () => {
    const signer = MockSigner.create();
    const customWallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
      oorLimitFraction: 0.05, // 5%
      oorLimitMinSats: 500_000, // 0.005 BTC floor
    });

    // 20M sats. 5% = 1M > 500K floor. Limit = 1M.
    vi.spyOn(customWallet.sdkWallet, 'getBalance').mockResolvedValue({
      total: 20_000_000,
      available: 20_000_000,
      settled: 20_000_000,
      preconfirmed: 0,
      lockedInRounds: 0,
      swept: 0,
    });
    vi.spyOn(customWallet.sdkWallet, 'sendBitcoin').mockResolvedValue('txid');

    await expect(customWallet.sendBitcoin({ address: 'tark1mock', amount: 1_000_000 }))
      .resolves.toBe('txid');

    await expect(customWallet.sendBitcoin({ address: 'tark1mock', amount: 1_000_001 }))
      .rejects.toThrow(OorLimitExceededError);
  }, 15_000);

  it('OorLimitExceededError contains correct metadata', async () => {
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockResolvedValue({
      total: 20_000_000,
      available: 20_000_000,
      settled: 20_000_000,
      preconfirmed: 0,
      lockedInRounds: 0,
      swept: 0,
    });

    try {
      await wallet.sendBitcoin({ address: 'tark1mock', amount: 5_000_000 });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OorLimitExceededError);
      const oorErr = err as OorLimitExceededError;
      expect(oorErr.requestedSats).toBe(5_000_000);
      expect(oorErr.limitSats).toBe(2_000_000);
      expect(oorErr.totalBalance).toBe(20_000_000);
      expect(oorErr.name).toBe('OorLimitExceededError');
    }
  }, 15_000);

  it('sendBitcoin calls through to SDK sendBitcoin on success', async () => {
    vi.spyOn(wallet.sdkWallet, 'getBalance').mockResolvedValue({
      total: 20_000_000,
      available: 20_000_000,
      settled: 20_000_000,
      preconfirmed: 0,
      lockedInRounds: 0,
      swept: 0,
    });
    const sendSpy = vi.spyOn(wallet.sdkWallet, 'sendBitcoin').mockResolvedValue('real-txid');

    const result = await wallet.sendBitcoin({ address: 'tark1someaddr', amount: 100_000 });
    expect(result).toBe('real-txid');
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith({ address: 'tark1someaddr', amount: 100_000 });
  }, 15_000);
});
