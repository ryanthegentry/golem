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
}

export const MUTINYNET_CONFIG: GolemWalletConfig = {
  arkServerUrl: 'https://mutinynet.arkade.sh',
  esploraUrl: 'https://mutinynet.com/api',
  dataDir: './data',
};
