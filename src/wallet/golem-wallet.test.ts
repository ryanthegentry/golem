import { describe, it, expect } from 'vitest';
import { hex } from '@scure/base';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from './golem-wallet.js';
import { walletConfigFromNetwork } from './config.js';
import { getNetworkConfig } from '../config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

/**
 * Integration tests that connect to the live mutinynet Ark server.
 * These require network access but no testnet funds.
 */
describe('GolemWallet (mutinynet)', () => {
  it('creates a wallet and fetches addresses', async () => {
    const signer = MockSigner.create();
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null, // in-memory for tests
    });

    const arkAddress = await wallet.getAddress();
    expect(arkAddress).toBeTruthy();
    expect(arkAddress.startsWith('tark1') || arkAddress.startsWith('ark1')).toBe(true);

    const boardingAddress = await wallet.getBoardingAddress();
    expect(boardingAddress).toBeTruthy();
    // Mutinynet uses tb1 or tbc1 prefix for testnet addresses
    expect(boardingAddress.startsWith('tb1')).toBe(true);

    console.log('Ark address:', arkAddress);
    console.log('Boarding address:', boardingAddress);
  }, 15_000);

  it('reports zero balance for fresh wallet', async () => {
    const signer = MockSigner.create();
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });

    const balance = await wallet.getBalance();
    expect(balance.total).toBe(0);
    expect(balance.available).toBe(0);
    expect(balance.settled).toBe(0);
    expect(balance.preconfirmed).toBe(0);

    console.log('Balance:', balance);
  }, 15_000);

  it('returns signer info', async () => {
    const signer = MockSigner.create();
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });

    const info = await wallet.getSignerInfo();
    expect(info.type).toBe('mock');
    expect(info.label).toContain('MockSigner');
  }, 15_000);

  it('returns 33-byte public key', async () => {
    const signer = MockSigner.create();
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });

    const pubkey = await wallet.getPublicKey();
    expect(pubkey.length).toBe(33);
    expect([0x02, 0x03]).toContain(pubkey[0]);

    console.log('Public key:', hex.encode(pubkey));
  }, 15_000);

  it('consistent addresses from same signer', async () => {
    const secret = new Uint8Array(32);
    secret[31] = 42;
    const signer = MockSigner.fromSecretKey(secret);

    const wallet1 = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });
    const wallet2 = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });

    const addr1 = await wallet1.getAddress();
    const addr2 = await wallet2.getAddress();
    expect(addr1).toBe(addr2);
  }, 15_000);

  it('no expiring VTXOs for fresh wallet', async () => {
    const signer = MockSigner.create();
    const wallet = await GolemWallet.create(signer, {
      ...MUTINYNET_CONFIG,
      dataDir: null,
    });

    const expiring = await wallet.getExpiringVtxos();
    expect(expiring).toEqual([]);
  }, 15_000);
});
