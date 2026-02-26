/**
 * L402 Gateway end-to-end test.
 *
 * Starts the mock backend + gateway, then runs through the L402 flow.
 */

// EventSource polyfill — MUST be set before any SDK imports
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { MUTINYNET_CONFIG } from '../wallet/config.js';
import { createL402Gateway } from './gateway.js';
import { mintL402Macaroon, MemoryRootKeyStore } from './macaroon.js';

const BACKEND_PORT = 3099;
const GATEWAY_PORT = 8499;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- 1. Start mock backend ---

function startBackend() {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/docs', (c) => c.json({ endpoints: ['/v1/aqi'], description: 'BreatheLocal mock API' }));
  app.get('/v1/aqi', (c) => {
    return c.json({
      aqi: 42,
      location: 'Portland, OR',
      lat: parseFloat(c.req.query('lat') || '45.52'),
      lng: parseFloat(c.req.query('lng') || '-122.68'),
      forecast: 'Good',
      timestamp: new Date().toISOString(),
    });
  });

  return serve({ fetch: app.fetch, port: BACKEND_PORT, hostname: '0.0.0.0' }, () => {
    console.log(`[backend] Mock API on :${BACKEND_PORT}`);
  });
}

// --- 2. Start L402 gateway ---

async function startGateway() {
  const signer = MockSigner.create();
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: null });

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

  const rootKeyStore = new MemoryRootKeyStore();

  const gateway = createL402Gateway(lightning, {
    priceSats: 1000,
    rootKeyStore,
    description: 'BreatheLocal API — 1000 sats per request',
    freePaths: ['/health', '/docs'],
  });

  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/docs', (c) => c.json({ endpoints: ['/v1/aqi'] }));
  app.use('/*', gateway.middleware);
  app.all('/*', async (c) => {
    const url = new URL(c.req.url);
    const target = `http://localhost:${BACKEND_PORT}${url.pathname}${url.search}`;
    const res = await fetch(target, { method: c.req.method });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
    });
  });

  const server = serve({ fetch: app.fetch, port: GATEWAY_PORT, hostname: '0.0.0.0' }, () => {
    console.log(`[gateway] L402 gateway on :${GATEWAY_PORT} → :${BACKEND_PORT}`);
  });

  return { server, gateway, rootKeyStore, lightning };
}

// --- 3. Run tests ---

async function main() {
  console.log('=== L402 Gateway E2E Test ===\n');

  const backend = startBackend();
  const { server: gw, gateway, rootKeyStore, lightning } = await startGateway();

  await sleep(1000); // Let servers bind

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  PASS: ${name}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`);
      failed++;
    }
  }

  // --- Test A: /health is free ---
  console.log('\n--- Test A: Free path /health ---');
  {
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/health`);
    const body = await res.json();
    assert('/health returns 200', res.status === 200);
    assert('/health body has status=ok', body.status === 'ok');
  }

  // --- Test B: /docs is free ---
  console.log('\n--- Test B: Free path /docs ---');
  {
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/docs`);
    assert('/docs returns 200', res.status === 200);
  }

  // --- Test C: /v1/aqi without payment returns 402 ---
  console.log('\n--- Test C: Unpaid request → 402 ---');
  let challengeMacaroon = '';
  let challengeInvoice = '';
  {
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/v1/aqi?lat=45.52&lng=-122.68`);
    const body = await res.json();
    const wwwAuth = res.headers.get('www-authenticate') || '';

    assert('Returns 402', res.status === 402);
    assert('Has WWW-Authenticate header', wwwAuth.startsWith('L402 '));
    assert('Body has invoice', typeof body.invoice === 'string' && body.invoice.startsWith('lntbs'));
    assert('Body has macaroon', typeof body.macaroon === 'string' && body.macaroon.length > 0);
    assert('Body has paymentHash', typeof body.paymentHash === 'string' && body.paymentHash.length === 64);
    assert('Body has price', body.price === 1000);

    challengeMacaroon = body.macaroon;
    challengeInvoice = body.invoice;

    console.log(`\n  Invoice: ${challengeInvoice.slice(0, 60)}...`);
    console.log(`  Payment hash: ${body.paymentHash}`);
    console.log(`  Macaroon: ${challengeMacaroon.slice(0, 60)}...`);
  }

  // --- Test D: Invalid L402 token rejected ---
  console.log('\n--- Test D: Invalid L402 token → 402 ---');
  {
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/v1/aqi`, {
      headers: { 'Authorization': 'L402 garbage:garbage' },
    });
    assert('Invalid token returns 402', res.status === 402);
  }

  // --- Test E: Valid L402 token (mock — we control the root key) ---
  console.log('\n--- Test E: Valid L402 token → 200 + upstream data ---');
  {
    // Create a valid macaroon + preimage pair using the gateway's root key store
    const preimage = randomBytes(32).toString('hex');
    const paymentHash = createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex');
    const { macaroonBase64: macaroon } = mintL402Macaroon(rootKeyStore, { paymentHash });

    const res = await fetch(`http://localhost:${GATEWAY_PORT}/v1/aqi?lat=45.52&lng=-122.68`, {
      headers: { 'Authorization': `L402 ${macaroon}:${preimage}` },
    });
    const body = await res.json();

    assert('Valid token returns 200', res.status === 200);
    assert('Upstream AQI data received', body.aqi === 42);
    assert('Upstream location correct', body.location === 'Portland, OR');
    assert('Upstream lat correct', body.lat === 45.52);

    console.log(`\n  Upstream response: ${JSON.stringify(body)}`);
  }

  // --- Test F: Stats ---
  console.log('\n--- Test F: Gateway stats ---');
  {
    console.log(`  Stats: ${JSON.stringify(gateway.stats)}`);
    assert('Total requests counted', gateway.stats.totalRequests > 0);
    assert('Challenges issued', gateway.stats.challengesIssued >= 1);
    assert('Paid requests counted', gateway.stats.paidRequests >= 1);
    assert('Sats earned tracked', gateway.stats.totalSatsEarned >= 1000);
  }

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (challengeInvoice) {
    console.log(`\nTo test with a real Lightning payment:`);
    console.log(`  1. Pay: ${challengeInvoice}`);
    console.log(`  2. Get preimage from HTLC settlement`);
    console.log(`  3. curl -H 'Authorization: L402 ${challengeMacaroon.slice(0, 20)}...:<preimage>' http://localhost:${GATEWAY_PORT}/v1/aqi`);
  }

  // Cleanup
  backend.close();
  gw.close();
  await lightning.dispose();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
