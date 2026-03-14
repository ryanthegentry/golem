/**
 * Shared wallet initialization for CLI commands.
 *
 * Centralizes ServerSigner -> GolemWallet setup so balance, gateway, etc.
 * don't each duplicate the boilerplate. Supports both plaintext and
 * encrypted key configs.
 */

import * as readline from 'node:readline';
import { ServerSigner } from '../signer/server-signer.js';
import { ReadOnlySigner } from '../signer/read-only-signer.js';
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
  let signer: ServerSigner | ReadOnlySigner;

  if (config.privateKey) {
    signer = ServerSigner.fromSecretKeyHex(config.privateKey);
  } else if (config.encryptedKey) {
    if (!password) {
      throw new Error('Encrypted wallet requires a password. Set GOLEM_PASSWORD or run interactively.');
    }
    signer = ServerSigner.fromEncrypted(config.encryptedKey, password);
  } else if (config.publicKey) {
    signer = new ReadOnlySigner(Buffer.from(config.publicKey, 'hex'));
  } else {
    throw new Error('Config has neither privateKey, encryptedKey, nor publicKey. Run \'golem init\' again.');
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
    // Write prompt to stderr (doesn't mix with piped stdout)
    process.stderr.write(prompt);

    // Disable echo so password characters don't appear on screen
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    let input = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          // Enter pressed — done
          process.stdin.removeListener('data', onData);
          if (process.stdin.setRawMode) {
            process.stdin.setRawMode(wasRaw ?? false);
          }
          process.stdin.pause();
          process.stderr.write('\n');
          resolve(input);
          return;
        }
        if (ch === '\x7f' || ch === '\b') {
          // Backspace
          input = input.slice(0, -1);
        } else if (ch === '\x03') {
          // Ctrl+C — abort
          process.stderr.write('\n');
          process.exit(1);
        } else if (ch >= ' ') {
          input += ch;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}
