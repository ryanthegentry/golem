import { type NetworkConfig } from '../config/networks.js';

export interface GolemWalletConfig {
  arkServerUrl: string;
  esploraUrl: string;
  networkName: 'bitcoin' | 'testnet' | 'signet' | 'mutinynet' | 'regtest';
  /** null = in-memory */
  dataDir: string | null;
  /** Fraction of total balance. Default: 0.10 */
  oorLimitFraction: number;
  /** Default: 1_000_000 (0.01 BTC) */
  oorLimitMinSats: number;
}

export function walletConfigFromNetwork(netConfig: NetworkConfig, dataDir?: string): GolemWalletConfig {
  return {
    arkServerUrl: netConfig.arkServerUrl,
    esploraUrl: netConfig.mempoolUrl,
    networkName: netConfig.networkName,
    dataDir: dataDir ?? './data',
    oorLimitFraction: 0.10,
    oorLimitMinSats: 1_000_000,
  };
}