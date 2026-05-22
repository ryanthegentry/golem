import type { NetworkName } from '@arkade-os/sdk';

/**
 * Network configuration for Golem — mainnet, mutinynet, regtest.
 *
 * GOLEM_NETWORK env var selects the active network. Defaults to mutinynet.
 * All URLs and thresholds are centralized here. No hardcoded URLs elsewhere.
 */

export type GolemNetwork = 'mainnet' | 'mutinynet' | 'regtest';

export interface NetworkConfig {
  /** Golem network identifier */
  golemNetwork: GolemNetwork;
  /** Arkade SDK network identifier */
  network: NetworkName;
  /** Arkade SDK NetworkName for OnchainWallet */
  networkName: NetworkName;
  /** Ark server URL */
  arkServerUrl: string;
  /** Boltz API URL — MUST be explicit, SDK has no mainnet default */
  boltzApiUrl: string;
  /** Esplora / mempool API URL */
  mempoolUrl: string;
  /** Whether encryption is required (mainnet = true) */
  encryptionRequired: boolean;
  /** Whether safe harbor address is required before boarding */
  safeHarborRequired: boolean;
  /** VTXO expiry in seconds */
  vtxoExpirySeconds: number;
  /** CRITICAL alert threshold — seconds before expiry */
  refreshAlertThresholdSeconds: number;
  /** WARNING alert threshold — seconds before expiry */
  refreshWarningThresholdSeconds: number;
  /** Bech32 address prefix for validation */
  addressPrefix: string;
  /** Expected address prefixes for safe harbor addresses */
  validAddressPrefixes: string[];
}

export const NETWORK_CONFIGS: Record<GolemNetwork, NetworkConfig> = {
  mainnet: {
    golemNetwork: 'mainnet',
    network: 'bitcoin',
    networkName: 'bitcoin',
    arkServerUrl: 'https://arkade.computer',
    boltzApiUrl: 'https://api.ark.boltz.exchange',
    mempoolUrl: 'https://mempool.space/api',
    encryptionRequired: true,
    safeHarborRequired: true,
    vtxoExpirySeconds: 605184,            // 7 days — confirmed from live API
    refreshAlertThresholdSeconds: 172800,  // 48 hours = CRITICAL
    refreshWarningThresholdSeconds: 259200, // 72 hours = WARNING
    addressPrefix: 'bc1',
    validAddressPrefixes: ['bc1', '1', '3'],
  },
  mutinynet: {
    golemNetwork: 'mutinynet',
    network: 'mutinynet',
    networkName: 'mutinynet',
    arkServerUrl: 'https://mutinynet.arkade.sh',
    boltzApiUrl: 'https://api.boltz.mutinynet.arkade.sh',
    mempoolUrl: 'https://mutinynet.com/api',
    encryptionRequired: false,
    safeHarborRequired: false,
    vtxoExpirySeconds: 172544,            // ~2 days
    refreshAlertThresholdSeconds: 43200,   // 12 hours
    refreshWarningThresholdSeconds: 64800,  // 18 hours
    addressPrefix: 'tb1',
    validAddressPrefixes: ['tb1', 'bcrt1', '2', 'm', 'n'],
  },
  regtest: {
    golemNetwork: 'regtest',
    network: 'regtest',
    networkName: 'regtest',
    arkServerUrl: 'http://localhost:7070',
    boltzApiUrl: 'http://localhost:9069',
    mempoolUrl: 'http://localhost:3006/api',
    encryptionRequired: false,
    safeHarborRequired: false,
    vtxoExpirySeconds: 3600,
    refreshAlertThresholdSeconds: 900,
    refreshWarningThresholdSeconds: 1800,
    addressPrefix: 'bcrt1',
    validAddressPrefixes: ['bcrt1', '2', 'm', 'n'],
  },
};

/**
 * Get network config from GOLEM_NETWORK env var (default: mutinynet).
 */
export function getNetworkConfig(network?: string): NetworkConfig {
  const net = (network || process.env.GOLEM_NETWORK || 'mutinynet') as GolemNetwork;
  const config = NETWORK_CONFIGS[net];
  if (!config) {
    throw new Error(`Unknown network: ${net}. Valid: mainnet, mutinynet, regtest`);
  }
  return config;
}

/**
 * Map GolemNetwork to the address validation network expected by validateBitcoinAddress.
 */
export function toAddressNetwork(network: GolemNetwork): 'mainnet' | 'testnet' | 'mutinynet' {
  switch (network) {
    case 'mainnet': return 'mainnet';
    case 'mutinynet': return 'mutinynet';
    case 'regtest': return 'mutinynet'; // regtest uses same bcrt1 prefix
    default: throw new Error(`Unknown network: ${network satisfies never}`);
  }
}
