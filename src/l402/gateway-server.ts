// EventSource polyfill — MUST be set before any SDK imports
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { MUTINYNET_CONFIG } from '../wallet/config.js';
import { createL402Gateway } from './gateway.js';
import { FileRootKeyStore, MemoryRootKeyStore } from './macaroon.js';

// --- Config from env ---

const upstreamUrl = process.env.GOLEM_UPSTREAM_URL;
if (!upstreamUrl) {
  console.error('GOLEM_UPSTREAM_URL required (e.g. http://localhost:3000)');
  process.exit(1);
}

const signerKey = process.env.GOLEM_SIGNER_KEY;
if (!signerKey) {
  console.error('GOLEM_SIGNER_KEY required (hex-encoded 32-byte secret)');
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
console.log(`[l402] Root keys stored at: ${rootKeyStore.getFilePath()}`);

// --- Initialize wallet + lightning ---

console.log('Initializing Golem wallet for L402 gateway...');

const signer = MockSigner.fromSecretKey(Buffer.from(signerKey, 'hex'));
const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir });

const swapProvider = new BoltzSwapProvider({
  apiUrl: 'https://api.boltz.mutinynet.arkade.sh',
  network: 'mutinynet',
  referralId: 'golem',
});

const lightning = new ArkadeLightning({
  wallet: wallet.sdkWallet,
  swapProvider,
  swapManager: { enableAutoActions: true },
});

await lightning.startSwapManager();
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
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
});

// Free: health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Free: stats
app.get('/stats', (c) => c.json(gateway.stats));

// Free: preimage endpoint (Ark OOR payment polling)
app.get('/l402/preimage', gateway.preimageHandler);

// All other routes: L402 gated, proxied to upstream
app.use('/*', gateway.middleware);

app.all('/*', async (c) => {
  // Proxy to upstream
  const url = new URL(c.req.url);
  const upstreamTarget = `${upstreamUrl}${url.pathname}${url.search}`;

  try {
    const headers = new Headers();
    // Forward select headers
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

// --- Start ---

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`L402 gateway running on http://0.0.0.0:${port} ${arkAddress ? '(dual-mode: Lightning + Ark)' : '(Lightning only)'}`);
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
