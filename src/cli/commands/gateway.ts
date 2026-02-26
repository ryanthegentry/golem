/**
 * golem gateway — Start a dual-mode L402 reverse proxy (Lightning + Ark OOR)
 */

import { Command } from 'commander';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { BoltzSwapProvider, ArkadeLightning } from '@arkade-os/boltz-swap';
import { loadConfig } from '../config.js';
import { createWalletFromConfig } from '../wallet.js';
import { createL402Gateway } from '../../l402/gateway.js';
import { MemoryRootKeyStore } from '../../l402/macaroon.js';
import { MUTINYNET_LIGHTNING_CONFIG } from '../../lightning/config.js';

export const gatewayCommand = new Command('gateway')
  .description('Start a dual-mode L402 reverse proxy (Lightning + Ark OOR)')
  .requiredOption('--upstream <url>', 'Upstream server URL to proxy to')
  .requiredOption('--price <sats>', 'Price per request in satoshis')
  .option('--port <port>', 'Port to listen on', '8402')
  .option('--currency <currency>', 'Currency for pricing', 'sats')
  .option('--description <text>', 'Description shown in 402 responses')
  .option('--free-paths <paths>', 'Comma-separated paths that skip payment', '/health,/stats')
  .option('--no-ark', 'Disable Ark-native OOR payments (Lightning only)')
  .action(async (opts) => {
    if (opts.currency && opts.currency !== 'sats') {
      console.error('Error: Only sats currency is supported. USD pricing coming soon.');
      process.exit(1);
    }

    const config = loadConfig();
    const port = parseInt(opts.port, 10);
    const priceSats = parseInt(opts.price, 10);
    const freePaths = opts.freePaths.split(',').map((p: string) => p.trim());

    if (isNaN(priceSats) || priceSats <= 0) {
      console.error('Error: --price must be a positive number of satoshis.');
      process.exit(1);
    }

    console.log('Connecting to Ark server...');
    const wallet = await createWalletFromConfig(config);

    console.log('Starting Lightning swap provider...');
    const swapProvider = new BoltzSwapProvider({
      apiUrl: MUTINYNET_LIGHTNING_CONFIG.boltzApiUrl,
      network: MUTINYNET_LIGHTNING_CONFIG.network,
      referralId: MUTINYNET_LIGHTNING_CONFIG.referralId,
    });

    const lightning = new ArkadeLightning({
      wallet: wallet.sdkWallet,
      swapProvider,
      swapManager: { enableAutoActions: true },
    });

    await lightning.startSwapManager();
    console.log('SwapManager started');

    // Get Ark address for OOR payments
    let arkAddress: string | undefined;
    if (opts.ark !== false) {
      try {
        arkAddress = await wallet.getAddress();
        console.log(`Ark OOR payments enabled: ${arkAddress}`);
      } catch (err) {
        console.warn('Could not get Ark address — Ark OOR payments disabled:', err instanceof Error ? err.message : err);
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

    // Build Hono app
    const app = new Hono();

    // Free: health check
    app.get('/health', (c) => c.json({ status: 'ok' }));

    // Free: gateway stats
    app.get('/stats', (c) => c.json(gateway.stats));

    // Free: preimage endpoint (for Ark OOR payment polling)
    app.get('/l402/preimage', gateway.preimageHandler);

    // L402 gate on all other routes
    app.use('/*', gateway.middleware);

    // Proxy to upstream
    app.all('/*', async (c) => {
      const url = new URL(c.req.url);
      const upstreamTarget = `${opts.upstream}${url.pathname}${url.search}`;

      try {
        const headers = new Headers();
        for (const key of ['content-type', 'accept', 'user-agent']) {
          const val = c.req.header(key);
          if (val) headers.set(key, val);
        }

        const res = await fetch(upstreamTarget, {
          method: c.req.method,
          headers,
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text(),
        });

        const body = await res.text();
        const contentType = res.headers.get('content-type') || 'application/json';

        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': contentType },
        });
      } catch (err) {
        console.error(`[proxy] Failed to reach upstream ${upstreamTarget}:`, err instanceof Error ? err.message : err);
        return c.json({ error: 'Upstream unavailable' }, 502);
      }
    });

    // Start server with EADDRINUSE handling
    const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
      console.log('');
      console.log(`L402 gateway running! ${arkAddress ? '(dual-mode: Lightning + Ark)' : '(Lightning only)'}`);
      console.log('');
      console.log(`  URL:        http://0.0.0.0:${port}`);
      console.log(`  Upstream:   ${opts.upstream}`);
      console.log(`  Price:      ${priceSats} sats/request`);
      console.log(`  Free paths: ${freePaths.join(', ')}`);
      console.log(`  Network:    ${config.network}`);
      if (arkAddress) {
        console.log(`  Ark addr:   ${arkAddress}`);
      }
      console.log('');
      console.log('Press Ctrl+C to stop.');
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Error: Port ${port} already in use. Is another gateway running?`);
        process.exit(1);
      }
      throw err;
    });

    // Clean shutdown
    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      gateway.dispose();
      server.close();
      process.exit(0);
    });
  });
