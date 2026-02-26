/**
 * Golem CLI config — load/save ~/.golem/config.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface GolemConfig {
  version: number;
  network: string;
  arkServer: string;
  privateKey: string;
  walletAddress: string;
  createdAt: string;
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
  const config = JSON.parse(raw) as GolemConfig;

  if (
    typeof config.version !== 'number' ||
    typeof config.network !== 'string' ||
    typeof config.arkServer !== 'string' ||
    typeof config.privateKey !== 'string' ||
    typeof config.walletAddress !== 'string' ||
    typeof config.createdAt !== 'string'
  ) {
    throw new Error(`Invalid config at ${configPath}. Delete it and run 'golem init' again.`);
  }

  return config;
}

export function saveConfig(config: GolemConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
