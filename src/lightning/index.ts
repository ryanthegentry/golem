import { BoltzSwapProvider, ArkadeLightning } from '@arkade-os/boltz-swap';
import type { Wallet } from '@arkade-os/sdk';
import type { NetworkConfig } from '../config/networks.js';
import { lightningConfigFromNetwork } from './config.js';

export type { GolemLightningConfig } from './config.js';
export { lightningConfigFromNetwork } from './config.js';
export { ArkadeLightning } from '@arkade-os/boltz-swap';

/**
 * Create and start an ArkadeLightning instance from an SDK wallet and network config.
 *
 * Encapsulates the BoltzSwapProvider + ArkadeLightning + startSwapManager boilerplate
 * that was previously duplicated across gateway, serve, receive, pay-lightning, pay-l402,
 * and gateway-server.
 */
export async function createLightning(
  sdkWallet: Wallet,
  netConfig: NetworkConfig,
): Promise<ArkadeLightning> {
  const lnConfig = lightningConfigFromNetwork(netConfig);

  const swapProvider = new BoltzSwapProvider({
    apiUrl: lnConfig.boltzApiUrl,
    network: lnConfig.network,
    referralId: lnConfig.referralId,
  });

  const lightning = new ArkadeLightning({
    wallet: sdkWallet,
    swapProvider,
    swapManager: { enableAutoActions: true },
  });

  await lightning.startSwapManager();

  return lightning;
}
