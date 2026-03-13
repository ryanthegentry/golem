// EventSource polyfill — MUST be set before any SDK imports
import '../polyfills.js';

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../wallet/config.js';
import { getNetworkConfig } from '../config/networks.js';
import { createL402Gateway } from './gateway.js';
import { FileRootKeyStore } from './macaroon.js';
import { createProxyHandler } from './proxy.js';
import { resolveServerSigner } from '../signer/resolve-signer.js';
import { createLightning } from '../lightning/index.js';
import { validateBearerToken } from '../auth/safe-compare.js';
import { secureHeaders } from 'hono/secure-headers';

// --- Config from env ---

const upstreamUrl = process.env.GOLEM_UPSTREAM_URL;
if (!upstreamUrl) {
  console.error('GOLEM_UPSTREAM_URL required (e.g. http://localhost:3000)');
  process.exit(1);
}

// Reject self-referencing upstream to prevent proxy-to-self attacks
try {
  const upstream = new URL(upstreamUrl);
  const gatewayPort = parseInt(process.env.GOLEM_PORT || '8402', 10);
  const upstreamHost = upstream.hostname;
  const upstreamPort = parseInt(upstream.port || (upstream.protocol === 'https:' ? '443' : '80'), 10);
  if ((upstreamHost === 'localhost' || upstreamHost === '127.0.0.1' || upstreamHost === '0.0.0.0') &&
      upstreamPort === gatewayPort) {
    console.error(`GOLEM_UPSTREAM_URL points to the gateway's own port (${gatewayPort}). This creates a self-proxy loop.`);
    process.exit(1);
  }
} catch {
  console.error(`Invalid GOLEM_UPSTREAM_URL: ${upstreamUrl}`);
  process.exit(1);
}

const priceSats = parseInt(process.env.GOLEM_PRICE_SATS || '1', 10);
const port = parseInt(process.env.GOLEM_PORT || '8402', 10);
const freePaths = (process.env.GOLEM_FREE_PATHS || '/health,/docs').split(',').map(p => p.trim());
const description = process.env.GOLEM_DESCRIPTION;
const ttlSeconds = parseInt(process.env.GOLEM_TTL_SECONDS || '300', 10);
const rateLimitPerMinute = parseInt(process.env.GOLEM_RATE_LIMIT || '30', 10);
const dataDir = process.env.GOLEM_DATA_DIR || './data-l402';

// Root key store — file-backed for persistence across restarts
const rootKeyStore = new FileRootKeyStore(dataDir);

// --- Initialize wallet + lightning ---

console.log('Initializing Golem wallet for L402 gateway...');

const signer = await resolveServerSigner().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});

const netConfig = getNetworkConfig();
const wallet = await GolemWallet.create(signer, walletConfigFromNetwork(netConfig, dataDir));

const lightning = await createLightning(wallet.sdkWallet, netConfig);
console.log('SwapManager started');

// --- Ark address for OOR payments ---

let arkAddress: string | undefined;
try {
  arkAddress = await wallet.getAddress();
  console.log(`Ark OOR payments enabled: ${arkAddress}`);
} catch (err) {
  console.warn('Could not get Ark address — Ark OOR payments disabled:', err instanceof Error ? err.message : err);
}

// --- Gateway ---

const gateway = createL402Gateway(lightning, {
  priceSats,
  rootKeyStore,
  description,
  freePaths: [...freePaths, '/l402/preimage'],
  ttlSeconds,
  rateLimitPerMinute,
  arkAddress,
  wallet: arkAddress ? wallet.sdkWallet : undefined,
});

// --- App ---

const app = new Hono();

// Security headers on all responses
app.use('*', secureHeaders());

// Free: health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Stats: fail-closed — requires GOLEM_API_KEY
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

// Free: preimage endpoint (Ark OOR payment polling)
app.get('/l402/preimage', gateway.preimageHandler);

// All other routes: L402 gated, proxied to upstream
app.use('/*', gateway.middleware);

app.all('/*', createProxyHandler(upstreamUrl));

// --- Start ---

const gatewayHost = process.env.GOLEM_GATEWAY_HOST || '0.0.0.0';
const server = serve({ fetch: app.fetch, port, hostname: gatewayHost }, () => {
  console.log(`L402 gateway running on http://${gatewayHost}:${port} ${arkAddress ? '(dual-mode: Lightning + Ark)' : '(Lightning only)'}`);
  console.log(`  Upstream: ${upstreamUrl}`);
  console.log(`  Price: ${priceSats} sats/request`);
  console.log(`  TTL: ${ttlSeconds}s`);
  console.log(`  Rate limit: ${rateLimitPerMinute}/min per IP`);
  console.log(`  Free paths: ${freePaths.join(', ')}`);
  if (arkAddress) {
    console.log(`  Ark addr: ${arkAddress}`);
  }
});

// Clean shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  gateway.dispose();
  server.close();
  process.exit(0);
});
