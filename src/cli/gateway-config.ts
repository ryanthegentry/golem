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
  /** Public URL agents will hit (e.g., 'https://my-gateway.example.com'). Required for 402index registration. */
  publicUrl?: string;
  /** Name shown in 402index directory. */
  serviceName?: string;
  /** Default: 'https://402index.io'. Override for self-hosted registries. */
  registryUrl?: string;
  /** e.g., 'ai/inference'. */
  category?: string;
  /** Operator contact email for 402index listing. */
  contactEmail?: string;
  /** JSON body for L402 verification probe. */
  probeBody?: string;
  /** Set false to skip 402index auto-registration on gateway start. Default: true. */
  autoRegister?: boolean;
  /** Enable response caching for cache-and-resell. Default: true. */
  cacheEnabled?: boolean;
  /** Default TTL for cached responses in seconds. Default: 3600. */
  cacheDefaultTtl?: number;
  /** Cache price as percentage of full price (1-100). Default: 20. */
  cachePricePercent?: number;
  /** Max cached entries before FIFO eviction. Default: 10000. */
  cacheMaxSize?: number;
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
