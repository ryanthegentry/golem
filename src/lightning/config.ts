import { type NetworkConfig } from '../config/networks.js';
import type { NetworkName } from '@arkade-os/sdk';

export interface GolemLightningConfig {
  boltzApiUrl: string;
  /** Must match Boltz and Ark server */
  network: NetworkName;
  referralId?: string;
}

export function lightningConfigFromNetwork(netConfig: NetworkConfig): GolemLightningConfig {
  return {
    boltzApiUrl: netConfig.boltzApiUrl,
    network: netConfig.network,
    referralId: 'golem',
  };
}
