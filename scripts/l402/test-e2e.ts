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
import { walletConfigFromNetwork } from '../wallet/config.js';
import { getNetworkConfig } from '../config/networks.js';
import { createL402Gateway } from './gateway.js';
import { mintL402Macaroon, MemoryRootKeyStore } from './macaroon.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

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

  // Get Ark address for dual-mode
  let arkAddress: string | undefined;
  try {
    arkAddress = await wallet.getAddress();
  } catch {
    // No Ark address available
  }

  const gateway = createL402Gateway(lightning, {
    priceSats: 1000,
    rootKeyStore,
    description: 'BreatheLocal API — 1000 sats per request',
    freePaths: ['/health', '/docs', '/l402/preimage'],
    arkAddress,
    wallet: arkAddress ? wallet.sdkWallet : undefined,
  });

  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/docs', (c) => c.json({ endpoints: ['/v1/aqi'] }));
  app.get('/l402/preimage', gateway.preimageHandler);
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

  // --- Test G: Ark OOR payment flow (simulated) ---
  console.log('\n--- Test G: Ark OOR payment flow ---');
  {
    // Request gated path — should get 402 with ark_payment
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/v1/aqi?lat=45.52&lng=-122.68`);
    const body = await res.json();

    const hasArkPayment = body.ark_payment && typeof body.ark_payment.payment_id === 'string';
    assert('402 includes ark_payment', hasArkPayment);

    if (hasArkPayment) {
      const arkPayment = body.ark_payment;
      assert('ark_payment has address', typeof arkPayment.address === 'string');
      assert('ark_payment has amount > price', arkPayment.amount > 1000 && arkPayment.amount <= 1099);
      assert('ark_payment has macaroon', typeof arkPayment.macaroon === 'string');

      // Simulate OOR fulfillment by directly setting pending.fulfilled
      const pending = gateway.pendingPayments.get(arkPayment.payment_id);
      assert('Pending payment exists', !!pending);

      if (pending) {
        // Before fulfillment: preimage endpoint returns 202
        const pendingRes = await fetch(`http://localhost:${GATEWAY_PORT}/l402/preimage?payment_id=${arkPayment.payment_id}`);
        assert('Preimage endpoint returns 202 before fulfillment', pendingRes.status === 202);

        // Simulate VTXO detection
        pending.fulfilled = true;

        // After fulfillment: preimage endpoint returns 200 with preimage
        const fulfilledRes = await fetch(`http://localhost:${GATEWAY_PORT}/l402/preimage?payment_id=${arkPayment.payment_id}`);
        const preimageBody = await fulfilledRes.json();
        assert('Preimage endpoint returns 200 after fulfillment', fulfilledRes.status === 200);
        assert('Preimage body has preimage', typeof preimageBody.preimage === 'string');
        assert('Preimage body has macaroon', typeof preimageBody.macaroon === 'string');

        // Use the Ark macaroon + preimage to access the gated path
        const authRes = await fetch(`http://localhost:${GATEWAY_PORT}/v1/aqi?lat=45.52&lng=-122.68`, {
          headers: { 'Authorization': `L402 ${preimageBody.macaroon}:${preimageBody.preimage}` },
        });
        const authBody = await authRes.json();
        assert('Ark L402 token returns 200', authRes.status === 200);
        assert('Ark L402 returns upstream data', authBody.aqi === 42);

        console.log(`\n  Ark payment verified: ${arkPayment.payment_id.slice(0, 16)}...`);
      }
    } else {
      console.log('  (Ark OOR not available — skipping Ark-specific tests)');
    }

    // Verify preimage endpoint returns 404 for bogus payment_id
    const bogusRes = await fetch(`http://localhost:${GATEWAY_PORT}/l402/preimage?payment_id=bogus123`);
    assert('Preimage endpoint returns 404 for unknown payment', bogusRes.status === 404);
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
  gateway.dispose();
  backend.close();
  gw.close();
  await lightning.dispose();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
