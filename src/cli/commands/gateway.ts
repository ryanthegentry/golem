/**
 * golem gateway — Start a dual-mode L402 reverse proxy (Lightning + Ark OOR)
 */

import { Command } from 'commander';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getWallet, exitWithError } from '../wallet.js';
import { startRefreshAgent } from '../refresh-setup.js';
import { createL402Gateway } from '../../l402/gateway.js';
import { createProxyHandler } from '../../l402/proxy.js';
import { getNetworkConfig } from '../../config/networks.js';
import { createLightning } from '../../lightning/index.js';
import { validateBearerToken } from '../../auth/safe-compare.js';

export const gatewayCommand = new Command('gateway')
  .description('Start a dual-mode L402 reverse proxy (Lightning + Ark OOR)')
  .requiredOption('--upstream <url>', 'Upstream server URL to proxy to')
  .requiredOption('--price <sats>', 'Price per request in satoshis')
  .option('--port <port>', 'Port to listen on', '8402')
  .option('--currency <currency>', 'Currency for pricing', 'sats')
  .option('--description <text>', 'Description shown in 402 responses')
  .option('--free-paths <paths>', 'Comma-separated paths that skip payment', '/health,/stats')
  .option('--no-ark', 'Disable Ark-native OOR payments (Lightning only)')
  .option('--trusted-proxy', 'Trust x-forwarded-for/x-real-ip headers for rate limiting (set when behind a reverse proxy)')
  .action(async (opts) => {
    if (opts.currency && opts.currency !== 'sats') {
      exitWithError('Only sats currency is supported. USD pricing coming soon.');
    }

    const port = parseInt(opts.port, 10);
    const priceSats = parseInt(opts.price, 10);
    const freePaths = opts.freePaths.split(',').map((p: string) => p.trim());

    // Set GOLEM_TRUSTED_PROXY so the gateway rate limiter reads x-forwarded-for
    if (opts.trustedProxy) {
      process.env.GOLEM_TRUSTED_PROXY = '1';
    }

    if (isNaN(priceSats) || priceSats <= 0) {
      exitWithError('--price must be a positive number of satoshis.');
    }

    const { wallet, config } = await getWallet();
    const netConfig = getNetworkConfig(config.network);
    const lightning = await createLightning(wallet.sdkWallet, netConfig);

    // Start RefreshAgent for VTXO protection
    // Pass gateway shutdown handle so emergency exit can stop accepting payments
    const gatewayHandle = { shutdown: () => { /* set below after gateway creation */ } };
    const { agent } = startRefreshAgent(wallet, config, gatewayHandle);

    // Get Ark address for OOR payments
    let arkAddress: string | undefined;
    if (opts.ark !== false) {
      try {
        arkAddress = await wallet.getAddress();
      } catch {
        // Ark address unavailable — gateway runs Lightning-only
      }
    }

    // Create L402 gateway (dual-mode if Ark address available)
    const gateway = createL402Gateway(lightning, {
      priceSats,
      description: opts.description,
      freePaths: [...freePaths, '/l402/preimage'],
      arkAddress,
      wallet: arkAddress ? wallet.sdkWallet : undefined,
    });

    // Wire gateway shutdown into the RefreshAgent's emergency exit handle
    gatewayHandle.shutdown = () => gateway.dispose();

    // Build Hono app
    const app = new Hono();

    // Free: health check
    app.get('/health', (c) => c.json({ status: 'ok' }));

    // Gateway stats — fail-closed: requires GOLEM_API_KEY
    const apiKey = process.env.GOLEM_API_KEY;
    app.get('/stats', (c) => {
      if (!apiKey) {
        return c.json({ error: 'GOLEM_API_KEY required for /stats' }, 403);
      }
      if (!validateBearerToken(c.req.header('Authorization'), apiKey)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      return c.json(gateway.getStats());
    });

    // Free: preimage endpoint (for Ark OOR payment polling)
    app.get('/l402/preimage', gateway.preimageHandler);

    // L402 gate on all other routes
    app.use('/*', gateway.middleware);

    // Proxy to upstream
    app.all('/*', createProxyHandler(opts.upstream));

    // Start server with EADDRINUSE handling
    const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
      console.log('');
      console.log('');
      console.log(`  URL:        http://0.0.0.0:${port}`);
      console.log(`  Upstream:   ${opts.upstream}`);
      console.log(`  Price:      ${priceSats} sats/request`);
      console.log(`  Free paths: ${freePaths.join(', ')}`);
      console.log(`  Network:    ${config.network}`);
      console.log(`  Lightning:  enabled (Boltz reverse swap, invoice generated per-request)`);
      if (arkAddress) {
        console.log(`  Ark OOR:    enabled (${arkAddress})`);
      } else {
        console.log(`  Ark OOR:    disabled (--no-ark)`);
      }
      console.log(`  Refresh:    ${agent.isRunning ? 'running' : 'stopped'} (${config.safeHarborAddress ? 'emergency exit enabled' : 'no safe harbor'})`);
      console.log('');
      console.log('Press Ctrl+C to stop.');
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        exitWithError(`Port ${port} already in use. Is another gateway running?`);
      }
      throw err;
    });

    // Clean shutdown
    process.on('SIGINT', () => {
      agent.stop();
      gateway.dispose();
      server.close();
      process.exit(0);
    });
  });
