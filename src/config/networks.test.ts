/**
 * Network config tests — Step 1: Environment-based network switching
 */

import {
  describe,
  it,
  expect,
  afterEach
} from 'vitest';
import { getNetworkConfig, toAddressNetwork, type GolemNetwork } from './networks.js';

describe('Network config', () => {
  const origEnv = process.env.GOLEM_NETWORK;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.GOLEM_NETWORK;
    } else {
      process.env.GOLEM_NETWORK = origEnv;
    }
  });

  it('mainnet config resolves correct URLs', () => {
    const config = getNetworkConfig('mainnet');
    expect(config.arkServerUrl).toBe('https://arkade.computer');
    expect(config.boltzApiUrl).toBe('https://api.ark.boltz.exchange');
    expect(config.mempoolUrl).toBe('https://mempool.space/api');
    expect(config.network).toBe('bitcoin');
    expect(config.networkName).toBe('bitcoin');
    expect(config.encryptionRequired).toBe(true);
    expect(config.safeHarborRequired).toBe(true);
  });

  it('mutinynet config resolves correct URLs (backward compat)', () => {
    const config = getNetworkConfig('mutinynet');
    expect(config.arkServerUrl).toBe('https://mutinynet.arkade.sh');
    expect(config.boltzApiUrl).toBe('https://api.boltz.mutinynet.arkade.sh');
    expect(config.mempoolUrl).toBe('https://mutinynet.com/api');
    expect(config.network).toBe('mutinynet');
    expect(config.networkName).toBe('mutinynet');
    expect(config.encryptionRequired).toBe(false);
    expect(config.safeHarborRequired).toBe(false);
  });

  it('regtest config resolves correct URLs', () => {
    const config = getNetworkConfig('regtest');
    expect(config.arkServerUrl).toBe('http://localhost:7070');
    expect(config.boltzApiUrl).toBe('http://localhost:9069');
    expect(config.network).toBe('regtest');
  });

  it('unknown network throws', () => {
    expect(() => getNetworkConfig('banana')).toThrow('Unknown network: banana');
  });

  it('defaults to mutinynet when no env var', () => {
    delete process.env.GOLEM_NETWORK;
    const config = getNetworkConfig();
    expect(config.golemNetwork).toBe('mutinynet');
  });

  it('respects GOLEM_NETWORK env var', () => {
    process.env.GOLEM_NETWORK = 'mainnet';
    const config = getNetworkConfig();
    expect(config.golemNetwork).toBe('mainnet');
  });

  it('explicit parameter overrides env var', () => {
    process.env.GOLEM_NETWORK = 'mainnet';
    const config = getNetworkConfig('mutinynet');
    expect(config.golemNetwork).toBe('mutinynet');
  });

  it('mainnet VTXO expiry is 7 days (605184 seconds)', () => {
    const config = getNetworkConfig('mainnet');
    expect(config.vtxoExpirySeconds).toBe(605184);
    // Verify 7 days
    expect(config.vtxoExpirySeconds / 86400).toBeCloseTo(7.0, 0);
  });

  it('mainnet alert thresholds are 48h and 72h', () => {
    const config = getNetworkConfig('mainnet');
    expect(config.refreshAlertThresholdSeconds).toBe(172800);  // 48 hours
    expect(config.refreshWarningThresholdSeconds).toBe(259200); // 72 hours
  });

  it('all networks have explicit boltzApiUrl', () => {
    const networks: GolemNetwork[] = ['mainnet', 'mutinynet', 'regtest'];
    for (const net of networks) {
      const config = getNetworkConfig(net);
      expect(config.boltzApiUrl).toBeTruthy();
      expect(config.boltzApiUrl.length).toBeGreaterThan(0);
    }
  });

  it('toAddressNetwork maps correctly', () => {
    expect(toAddressNetwork('mainnet')).toBe('mainnet');
    expect(toAddressNetwork('mutinynet')).toBe('mutinynet');
    expect(toAddressNetwork('regtest')).toBe('mutinynet');
  });
});

describe('Mainnet enforcement', () => {
  it('mainnet requires encryption', () => {
    const config = getNetworkConfig('mainnet');
    expect(config.encryptionRequired).toBe(true);
  });

  it('mainnet requires safe harbor', () => {
    const config = getNetworkConfig('mainnet');
    expect(config.safeHarborRequired).toBe(true);
  });

  it('mutinynet does not require encryption', () => {
    const config = getNetworkConfig('mutinynet');
    expect(config.encryptionRequired).toBe(false);
  });

  it('mutinynet does not require safe harbor', () => {
    const config = getNetworkConfig('mutinynet');
    expect(config.safeHarborRequired).toBe(false);
  });
});

describe('Address network validation', () => {
  it('mainnet valid prefixes include bc1', () => {
    const config = getNetworkConfig('mainnet');
    expect(config.validAddressPrefixes).toContain('bc1');
  });

  it('mainnet valid prefixes exclude tb1', () => {
    const config = getNetworkConfig('mainnet');
    expect(config.validAddressPrefixes).not.toContain('tb1');
  });

  it('mutinynet valid prefixes include tb1', () => {
    const config = getNetworkConfig('mutinynet');
    expect(config.validAddressPrefixes).toContain('tb1');
  });

  it('mutinynet valid prefixes exclude bc1', () => {
    const config = getNetworkConfig('mutinynet');
    // bc1 is mainnet bech32, should not be in mutinynet
    expect(config.validAddressPrefixes).not.toContain('bc1');
  });
});
