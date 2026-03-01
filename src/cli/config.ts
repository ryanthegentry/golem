/**
 * Golem CLI config — load/save ~/.golem/config.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isEncryptedKeyData, type EncryptedKeyData } from '../signer/key-crypto.js';
import { DEFAULT_EXIT_THRESHOLD_BLOCKS, DEFAULT_ONCHAIN_RESERVE_SATS } from '../config/defaults.js';

export interface GolemConfig {
  version: number;
  network: string;
  arkServer: string;
  /** Plaintext private key hex. Present for unencrypted wallets. */
  privateKey?: string;
  /** Encrypted private key. Present for encrypted wallets. */
  encryptedKey?: EncryptedKeyData;
  walletAddress: string;
  createdAt: string;
  /** On-chain Bitcoin address for emergency exit. Mandatory on mainnet, optional on testnet/mutinynet. */
  safeHarborAddress?: string;
  /** Blocks before VTXO expiry at which emergency exit triggers. Default: 432 (~72 hours). */
  safeHarborExitThresholdBlocks: number;
  /** Sats reserved on-chain for AnchorBumper fee-bump txs. Default: 50,000. */
  onchainReserveSats: number;
}

/** Override for testing — if set, used instead of ~/.golem */
let configDirOverride: string | null = null;

export function setConfigDir(dir: string | null): void {
  configDirOverride = dir;
}

export function getConfigDir(): string {
  return configDirOverride ?? path.join(os.homedir(), '.golem');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function getDataDir(): string {
  return path.join(getConfigDir(), 'data');
}

export function configExists(): boolean {
  return fs.existsSync(getConfigPath());
}

export function loadConfig(): GolemConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    throw new Error(`No config found at ${configPath}. Run 'golem init' first.`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  let config: GolemConfig;
  try {
    config = JSON.parse(raw) as GolemConfig;
  } catch {
    throw new Error(`Corrupt config at ${configPath}. Delete it and run 'golem init' again.`);
  }

  const hasPrivateKey = typeof config.privateKey === 'string';
  const hasEncryptedKey = isEncryptedKeyData(config.encryptedKey);

  if (
    typeof config.version !== 'number' ||
    typeof config.network !== 'string' ||
    typeof config.arkServer !== 'string' ||
    (!hasPrivateKey && !hasEncryptedKey) ||
    typeof config.walletAddress !== 'string' ||
    typeof config.createdAt !== 'string'
  ) {
    throw new Error(`Invalid config at ${configPath}. Delete it and run 'golem init' again.`);
  }

  // Backfill defaults for configs created before safe harbor was added
  if (typeof config.safeHarborExitThresholdBlocks !== 'number') {
    config.safeHarborExitThresholdBlocks = DEFAULT_EXIT_THRESHOLD_BLOCKS;
  }
  if (typeof config.onchainReserveSats !== 'number') {
    config.onchainReserveSats = DEFAULT_ONCHAIN_RESERVE_SATS;
  }

  return config;
}

export function saveConfig(config: GolemConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

/** Does this config require a password to unlock? */
export function configRequiresPassword(config: GolemConfig): boolean {
  return !config.privateKey && isEncryptedKeyData(config.encryptedKey);
}
