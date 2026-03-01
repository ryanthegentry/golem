import { describe, it, expect, vi } from 'vitest';

const mockStartSwapManager = vi.fn().mockResolvedValue(undefined);

// Mock the external boltz-swap module before importing
vi.mock('@arkade-os/boltz-swap', () => {
  return {
    BoltzSwapProvider: vi.fn().mockImplementation(function (this: any, opts: any) {
      this.apiUrl = opts.apiUrl;
      this.network = opts.network;
      this.referralId = opts.referralId;
    }),
    ArkadeLightning: vi.fn().mockImplementation(function (this: any, opts: any) {
      this.wallet = opts.wallet;
      this.swapProvider = opts.swapProvider;
      this.swapManager = opts.swapManager;
      this.startSwapManager = mockStartSwapManager;
    }),
  };
});

import { createLightning, lightningConfigFromNetwork } from './index.js';
import { BoltzSwapProvider, ArkadeLightning } from '@arkade-os/boltz-swap';
import { NETWORK_CONFIGS } from '../config/networks.js';

describe('lightning/index', () => {
  describe('lightningConfigFromNetwork', () => {
    it('extracts boltz URL and network from mutinynet config', () => {
      const config = lightningConfigFromNetwork(NETWORK_CONFIGS.mutinynet);
      expect(config.boltzApiUrl).toBe('https://api.boltz.mutinynet.arkade.sh');
      expect(config.network).toBe('mutinynet');
      expect(config.referralId).toBe('golem');
    });

    it('extracts boltz URL and network from mainnet config', () => {
      const config = lightningConfigFromNetwork(NETWORK_CONFIGS.mainnet);
      expect(config.boltzApiUrl).toBe('https://api.ark.boltz.exchange');
      expect(config.network).toBe('bitcoin');
    });

    it('extracts boltz URL and network from regtest config', () => {
      const config = lightningConfigFromNetwork(NETWORK_CONFIGS.regtest);
      expect(config.boltzApiUrl).toBe('http://localhost:9069');
      expect(config.network).toBe('regtest');
    });
  });

  describe('createLightning', () => {
    it('creates BoltzSwapProvider with correct config', async () => {
      const fakeWallet = {} as any;
      const netConfig = NETWORK_CONFIGS.mutinynet;

      await createLightning(fakeWallet, netConfig);

      expect(BoltzSwapProvider).toHaveBeenCalledWith({
        apiUrl: 'https://api.boltz.mutinynet.arkade.sh',
        network: 'mutinynet',
        referralId: 'golem',
      });
    });

    it('creates ArkadeLightning with wallet, provider, and auto-actions enabled', async () => {
      const fakeWallet = { id: 'test-wallet' } as any;
      const netConfig = NETWORK_CONFIGS.mutinynet;

      await createLightning(fakeWallet, netConfig);

      expect(ArkadeLightning).toHaveBeenCalledWith(
        expect.objectContaining({
          wallet: fakeWallet,
          swapProvider: expect.any(Object),
          swapManager: { enableAutoActions: true },
        }),
      );
    });

    it('calls startSwapManager and returns the lightning instance', async () => {
      const fakeWallet = {} as any;
      const netConfig = NETWORK_CONFIGS.mutinynet;

      const lightning = await createLightning(fakeWallet, netConfig);

      expect(mockStartSwapManager).toHaveBeenCalled();
      expect(lightning).toHaveProperty('wallet');
      expect(lightning).toHaveProperty('swapProvider');
    });
  });
});
