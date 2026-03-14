/**
 * Gateway config — load/save ~/.golem/golem.yaml
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { getConfigDir } from './config.js';

export interface GatewayConfig {
  upstream: string;
  price: number;
  description?: string;
  port?: number;
  freePaths?: string[];
}

interface GatewayYaml {
  gateway: GatewayConfig;
}

export function getGatewayConfigPath(): string {
  return path.join(getConfigDir(), 'golem.yaml');
}

export function gatewayConfigExists(): boolean {
  return fs.existsSync(getGatewayConfigPath());
}

export function loadGatewayConfig(): GatewayConfig | null {
  const configPath = getGatewayConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(raw) as GatewayYaml;

  if (!parsed?.gateway?.upstream || typeof parsed.gateway.price !== 'number') {
    return null;
  }

  return parsed.gateway;
}

export function saveGatewayConfig(config: GatewayConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const configPath = getGatewayConfigPath();
  const content = yaml.dump({ gateway: config }, { lineWidth: -1 });
  fs.writeFileSync(configPath, content, { encoding: 'utf-8', mode: 0o600 });
}
