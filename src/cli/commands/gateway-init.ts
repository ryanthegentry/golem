/**
 * golem gateway init — Interactive setup wizard for L402 gateway.
 *
 * Auto-discovers local services (Ollama) and writes golem.yaml.
 */

import { Command } from 'commander';
import { exitWithError } from '../wallet.js';
import {
  gatewayConfigExists,
  saveGatewayConfig,
  getGatewayConfigPath,
  type GatewayConfig,
} from '../gateway-config.js';
import { discoverOllama } from '../../discovery/ollama.js';

export const gatewayInitCommand = new Command('init')
  .description('Set up gateway config (auto-discovers Ollama)')
  .option('--force', 'Overwrite existing golem.yaml')
  .option('--upstream <url>', 'Upstream URL (skip auto-discovery)')
  .option('--price <sats>', 'Price per request in sats', '10')
  .option('--public-url <url>', 'Public URL for 402index registration')
  .option('--service-name <name>', 'Service name for 402index listing')
  .action(async (opts) => {
    if (gatewayConfigExists() && !opts.force) {
      exitWithError(`Gateway config already exists at ${getGatewayConfigPath()}. Use --force to overwrite.`);
    }

    const priceSats = parseInt(opts.price, 10);
    if (isNaN(priceSats) || priceSats <= 0) {
      exitWithError('--price must be a positive number of satoshis.');
    }

    let upstream: string;
    let description: string | undefined;

    if (opts.upstream) {
      // Manual upstream — skip discovery
      upstream = opts.upstream;
      console.log(`Using upstream: ${upstream}`);
    } else {
      // Auto-discovery
      console.log('Scanning for local services...');

      const ollama = await discoverOllama();
      if (ollama) {
        upstream = ollama.url;
        const modelName = ollama.models[0] ?? 'unknown';
        description = `Ollama — ${modelName}`;
        console.log(`Found Ollama at ${ollama.url}`);
        if (ollama.models.length > 0) {
          console.log(`  Models: ${ollama.models.join(', ')}`);
        }
      } else {
        exitWithError(
          'No local services found.\n' +
          '  - Start Ollama: ollama serve\n' +
          '  - Or specify manually: golem gateway init --upstream <url>'
        );
      }
    }

    const config: GatewayConfig = {
      upstream,
      price: priceSats,
      description,
      port: 8402,
      freePaths: ['/health', '/stats'],
      cacheEnabled: true,
      cacheDefaultTtl: 3600,
      cachePricePercent: 20,
      cacheMaxSize: 10000,
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
      ...(opts.serviceName ? { serviceName: opts.serviceName } : {}),
    };

    saveGatewayConfig(config);

    console.log('');
    console.log(`Gateway config written to ${getGatewayConfigPath()}`);
    console.log('');
    console.log(`  Upstream:   ${config.upstream}`);
    console.log(`  Price:      ${config.price} sats/request`);
    if (config.description) {
      console.log(`  Description: ${config.description}`);
    }
    console.log(`  Port:       ${config.port}`);
    console.log(`  Cache:      enabled (${config.cachePricePercent}% price, ${config.cacheDefaultTtl}s TTL, max ${config.cacheMaxSize} entries)`);
    console.log('');
    console.log('  Note: Streaming responses (text/event-stream) are NOT cached.');
    console.log('  For Ollama, use "stream": false in request body for cache hits.');
    if (config.publicUrl) {
      console.log(`  Public URL: ${config.publicUrl} (402index registration enabled)`);
    } else {
      console.log('');
      console.log('To auto-register with 402index.io, add to golem.yaml:');
      console.log('  publicUrl: https://your-public-domain.com');
    }
    console.log('');
    console.log('Run `golem gateway` to start the L402 gateway.');
  });
