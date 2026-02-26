/**
 * Shared wallet initialization for CLI commands.
 *
 * Centralizes MockSigner → GolemWallet setup so balance, gateway, etc.
 * don't each duplicate the boilerplate.
 */

import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { MUTINYNET_CONFIG } from '../wallet/config.js';
import { type GolemConfig, getDataDir } from './config.js';

/**
 * Create a GolemWallet from a saved CLI config.
 *
 * Uses the private key from config, connects to the configured Ark server,
 * and persists state to ~/.golem/data/.
 */
export async function createWalletFromConfig(config: GolemConfig): Promise<GolemWallet> {
  const signer = MockSigner.fromSecretKey(Buffer.from(config.privateKey, 'hex'));

  const walletConfig = {
    ...MUTINYNET_CONFIG,
    arkServerUrl: config.arkServer,
    dataDir: getDataDir(),
  };

  return GolemWallet.create(signer, walletConfig);
}
