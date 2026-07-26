import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockStartSwapManager,
  mockStopSwapManager,
  mockSetLogger,
  statsRef,
} = vi.hoisted(() => ({
  mockStartSwapManager: vi.fn().mockResolvedValue(undefined),
  mockStopSwapManager: vi.fn().mockResolvedValue(undefined),
  mockSetLogger: vi.fn(),
  statsRef: {
    current: {
      isRunning: true,
      monitoredSwaps: 2,
      websocketConnected: true,
      usePollingFallback: false,
    } as any,
  },
}));

// Mock the external boltz-swap module before importing
vi.mock('@arkade-os/boltz-swap', () => {
  return {
    BoltzSwapProvider: vi.fn().mockImplementation(function (this: any, opts: any) {
      this.apiUrl = opts.apiUrl;
      this.network = opts.network;
      this.referralId = opts.referralId;
    }),
    ArkadeSwaps: vi.fn().mockImplementation(function (this: any, opts: any) {
      this.wallet = opts.wallet;
      this.swapProvider = opts.swapProvider;
      this.swapManager = opts.swapManager;
      this.startSwapManager = mockStartSwapManager;
      this.stopSwapManager = mockStopSwapManager;
      this.getSwapManager = () => ({
        getStats: async () => statsRef.current,
        setPollInterval: vi.fn(),
        onWebSocketConnected: async () => () => {},
        onWebSocketDisconnected: async () => () => {},
      });
    }),
    setLogger: mockSetLogger,
  };
});

import {
  createLightning,
  lightningConfigFromNetwork,
  ensureSwapManagerHealthy,
  getPollMonitor,
} from './index.js';
import { BoltzSwapProvider, ArkadeSwaps } from '@arkade-os/boltz-swap';
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

    it('creates ArkadeSwaps with wallet, provider, and auto-actions enabled', async () => {
      const fakeWallet = { id: 'test-wallet' } as any;
      const netConfig = NETWORK_CONFIGS.mutinynet;

      await createLightning(fakeWallet, netConfig);

      expect(ArkadeSwaps).toHaveBeenCalledWith(
        expect.objectContaining({
          wallet: fakeWallet,
          swapProvider: expect.any(Object),
          swapManager: expect.objectContaining({ enableAutoActions: true }),
        }),
      );
    });

    /**
     * golem#2 RC1. `ArkadeSwaps` autostarts its SwapManager when `autoStart` is unset
     * (it defaults to true in 0.3.32), and `createLightning` then calls `startSwapManager()`
     * itself. The two race, the loser hits the `isRunning` guard, and the SDK logs
     * "SwapManager is already running" — the line seen on every cold start. Disabling
     * autostart makes initialisation single-path and deterministic.
     */
    it('disables SDK autostart so init happens exactly once', async () => {
      await createLightning({} as any, NETWORK_CONFIGS.mutinynet);

      expect(ArkadeSwaps).toHaveBeenCalledWith(
        expect.objectContaining({
          swapManager: expect.objectContaining({ autoStart: false }),
        }),
      );
    });

    it('installs the resilience logger into the SDK', async () => {
      mockSetLogger.mockClear();
      await createLightning({} as any, NETWORK_CONFIGS.mutinynet);

      expect(mockSetLogger).toHaveBeenCalledWith(
        expect.objectContaining({
          log: expect.any(Function),
          warn: expect.any(Function),
          error: expect.any(Function),
        }),
      );
    });

    it('exposes a poll monitor for the health endpoint', async () => {
      await createLightning({} as any, NETWORK_CONFIGS.mutinynet);
      expect(getPollMonitor()).not.toBeNull();
      expect(getPollMonitor()!.getHealth().breakerState).toBe('closed');
    });
  });

  describe('ensureSwapManagerHealthy — golem#2 idempotent init', () => {
    beforeEach(() => {
      mockStartSwapManager.mockClear();
      mockStopSwapManager.mockClear();
      statsRef.current = {
        isRunning: true,
        monitoredSwaps: 2,
        websocketConnected: true,
        usePollingFallback: false,
      };
    });

    it('reports healthy and does not restart a running, connected manager', async () => {
      const lightning = await createLightning({} as any, NETWORK_CONFIGS.mutinynet);
      mockStartSwapManager.mockClear();

      const report = await ensureSwapManagerHealthy(lightning as any);

      expect(report.healthy).toBe(true);
      expect(report.action).toBe('none');
      expect(mockStartSwapManager).not.toHaveBeenCalled();
    });

    it('starts a manager that is not running instead of silently returning the cache', async () => {
      const lightning = await createLightning({} as any, NETWORK_CONFIGS.mutinynet);
      mockStartSwapManager.mockClear();
      statsRef.current = { ...statsRef.current, isRunning: false };

      const report = await ensureSwapManagerHealthy(lightning as any);

      expect(report.action).toBe('started');
      expect(mockStartSwapManager).toHaveBeenCalledTimes(1);
    });

    it('rebinds a running manager whose subscription is dead', async () => {
      const lightning = await createLightning({} as any, NETWORK_CONFIGS.mutinynet);
      mockStartSwapManager.mockClear();
      // Running, but the socket is down and it has fallen back to polling — the shape of
      // the May 28 wedge, where the process was "up" but bound to nothing.
      statsRef.current = {
        isRunning: true,
        monitoredSwaps: 2,
        websocketConnected: false,
        usePollingFallback: true,
      };

      const report = await ensureSwapManagerHealthy(lightning as any);

      expect(report.action).toBe('rebound');
      expect(mockStopSwapManager).toHaveBeenCalledTimes(1);
      expect(mockStartSwapManager).toHaveBeenCalledTimes(1);
    });

    it('reports unhealthy rather than throwing when the manager is absent', async () => {
      const report = await ensureSwapManagerHealthy({
        getSwapManager: () => null,
      } as any);

      expect(report.healthy).toBe(false);
      expect(report.action).toBe('unavailable');
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
