/**
 * Golem wallet configuration.
 * Defaults target the Ark mutinynet testnet.
 */
export interface GolemWalletConfig {
  /** Ark server URL */
  arkServerUrl: string;
  /** Esplora API URL for on-chain data */
  esploraUrl: string;
  /** Directory for persistent wallet state (null = in-memory) */
  dataDir: string | null;
  /** Max OOR exposure as fraction of total balance. Default: 0.10 (10%) */
  oorLimitFraction: number;
  /** Absolute minimum OOR limit in sats. Default: 1_000_000 (0.01 BTC) */
  oorLimitMinSats: number;
}

export const MUTINYNET_CONFIG: GolemWalletConfig = {
  arkServerUrl: 'https://mutinynet.arkade.sh',
  esploraUrl: 'https://mutinynet.com/api',
  dataDir: './data',
  oorLimitFraction: 0.10,
  oorLimitMinSats: 1_000_000,
};
