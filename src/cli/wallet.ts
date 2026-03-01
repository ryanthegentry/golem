/**
 * Shared wallet initialization for CLI commands.
 *
 * Centralizes ServerSigner -> GolemWallet setup so balance, gateway, etc.
 * don't each duplicate the boilerplate. Supports both plaintext and
 * encrypted key configs.
 */

import * as readline from 'node:readline';
import { ServerSigner } from '../signer/server-signer.js';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../wallet/config.js';
import { getNetworkConfig } from '../config/networks.js';
import { type GolemConfig, loadConfig, configRequiresPassword, getDataDir } from './config.js';

/** Print error message and exit. Consistent error handling for CLI commands. */
export function exitWithError(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/**
 * Load config, resolve password, and create wallet in one call.
 *
 * Replaces the repeated 3-line pattern:
 *   const config = loadConfig();
 *   const password = await resolvePassword(config);
 *   const wallet = await createWalletFromConfig(config, password);
 */
export async function getWallet(): Promise<{ wallet: GolemWallet; config: GolemConfig }> {
  const config = loadConfig();
  const password = await resolvePassword(config);
  const wallet = await createWalletFromConfig(config, password);
  return { wallet, config };
}

/**
 * Create a GolemWallet from a saved CLI config.
 *
 * If the config has an encrypted key, password must be provided.
 * If the config has a plaintext key, password is ignored.
 */
export async function createWalletFromConfig(config: GolemConfig, password?: string): Promise<GolemWallet> {
  let signer: ServerSigner;

  if (config.privateKey) {
    signer = ServerSigner.fromSecretKeyHex(config.privateKey);
  } else if (config.encryptedKey) {
    if (!password) {
      throw new Error('Encrypted wallet requires a password. Set GOLEM_PASSWORD or run interactively.');
    }
    signer = ServerSigner.fromEncrypted(config.encryptedKey, password);
  } else {
    throw new Error('Config has neither privateKey nor encryptedKey. Run \'golem init\' again.');
  }

  const netConfig = getNetworkConfig(config.network);
  const walletConfig = {
    ...walletConfigFromNetwork(netConfig, getDataDir()),
    arkServerUrl: config.arkServer,
  };

  return GolemWallet.create(signer, walletConfig);
}

/**
 * Resolve password for an encrypted config.
 *
 * Priority: GOLEM_PASSWORD env var -> interactive readline prompt (if TTY).
 * Returns undefined if config doesn't need a password.
 */
export async function resolvePassword(config: GolemConfig): Promise<string | undefined> {
  if (!configRequiresPassword(config)) {
    return undefined;
  }

  // Check env var first
  const envPassword = process.env.GOLEM_PASSWORD;
  if (envPassword) {
    return envPassword;
  }

  // Interactive prompt
  if (process.stdin.isTTY) {
    const pw = await promptSecret('Enter wallet password: ');
    console.error('Tip: export GOLEM_PASSWORD=<pw> to avoid re-entering each command.');
    return pw;
  }

  throw new Error('Password required but no TTY available. Set GOLEM_PASSWORD environment variable.');
}

export function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr, // stderr so it doesn't mix with piped stdout
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
