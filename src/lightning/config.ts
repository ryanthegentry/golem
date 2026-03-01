import { type NetworkConfig } from '../config/networks.js';

export interface GolemLightningConfig {
  boltzApiUrl: string;
  /** Must match Boltz and Ark server */
  network: string;
  referralId?: string;
}

export function lightningConfigFromNetwork(netConfig: NetworkConfig): GolemLightningConfig {
  return {
    boltzApiUrl: netConfig.boltzApiUrl,
    network: netConfig.network,
    referralId: 'golem',
  };
}