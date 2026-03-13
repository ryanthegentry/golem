import { BoltzSwapProvider, ArkadeSwaps } from '@arkade-os/boltz-swap';
import type { Wallet } from '@arkade-os/sdk';
import type { NetworkConfig } from '../config/networks.js';
import { lightningConfigFromNetwork } from './config.js';

export type { GolemLightningConfig } from './config.js';
export { lightningConfigFromNetwork } from './config.js';
export { ArkadeSwaps } from '@arkade-os/boltz-swap';

/**
 * Create and start an ArkadeSwaps instance from an SDK wallet and network config.
 *
 * Encapsulates the BoltzSwapProvider + ArkadeSwaps + startSwapManager boilerplate
 * that was previously duplicated across gateway, serve, receive, pay-lightning, pay-l402,
 * and gateway-server.
 */
export async function createLightning(
  sdkWallet: Wallet,
  netConfig: NetworkConfig,
): Promise<ArkadeSwaps> {
  const lnConfig = lightningConfigFromNetwork(netConfig);

  const swapProvider = new BoltzSwapProvider({
    apiUrl: lnConfig.boltzApiUrl,
    network: lnConfig.network,
    referralId: lnConfig.referralId,
  });

  const lightning = new ArkadeSwaps({
    wallet: sdkWallet,
    swapProvider,
    swapManager: { enableAutoActions: true },
  });

  await lightning.startSwapManager();

  return lightning;
}
