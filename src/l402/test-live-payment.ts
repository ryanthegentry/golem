/**
 * L402 Gateway — Live Lightning payment test on mutinynet.
 *
 * Uses the real Golem wallet (funded from yesterday's PoC) as the payer,
 * and a fresh wallet as the gateway's receiver.
 */

// EventSource polyfill — MUST be set before any SDK imports
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { MUTINYNET_CONFIG } from '../wallet/config.js';
import { createL402Gateway } from './gateway.js';

const BACKEND_PORT = 3098;
const GATEWAY_PORT = 8498;
const BOLTZ_API = 'https://api.boltz.mutinynet.arkade.sh';

// Ryan's testnet signer key from CLAUDE.md
const PAYER_KEY = 'fixture';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function elapsed(start: number): string {
  return `${(Date.now() - start).toLocaleString()}ms`;
}

async function main() {
  console.log('=== L402 Live Payment Test (mutinynet) ===\n');
  const t0 = Date.now();

  // --- 1. Start mock backend ---
  const backendApp = new Hono();
  backendApp.get('/health', (c) => c.json({ status: 'ok' }));
  backendApp.get('/v1/aqi', (c) => c.json({
    aqi: 42,
    location: 'Portland, OR',
    lat: parseFloat(c.req.query('lat') || '45.52'),
    lng: parseFloat(c.req.query('lng') || '-122.68'),
    forecast: 'Good',
    timestamp: new Date().toISOString(),
  }));

  const backend = serve({ fetch: backendApp.fetch, port: BACKEND_PORT, hostname: '0.0.0.0' }, () => {
    console.log(`[backend] Mock API on :${BACKEND_PORT}`);
  });

  // --- 2. Start gateway with FRESH receiving wallet ---
  console.log('\nInitializing gateway wallet (fresh)...');
  const tGatewayInit = Date.now();

  const gatewaySigner = MockSigner.create();
  const gatewayWallet = await GolemWallet.create(gatewaySigner, { ...MUTINYNET_CONFIG, dataDir: null });

  const gatewaySwapProvider = new BoltzSwapProvider({
    apiUrl: BOLTZ_API,
    network: 'mutinynet',
    referralId: 'golem',
  });

  const gatewayLightning = new ArkadeLightning({
    wallet: gatewayWallet.sdkWallet,
    swapProvider: gatewaySwapProvider,
    swapManager: { enableAutoActions: true },
  });

  await gatewayLightning.startSwapManager();

  const rootKey = randomBytes(32).toString('hex');
  const gateway = createL402Gateway(gatewayLightning, {
    priceSats: 1000,
    rootKey,
    description: 'BreatheLocal API — 1000 sats',
    freePaths: ['/health'],
  });

  const gwApp = new Hono();
  gwApp.get('/health', (c) => c.json({ status: 'ok' }));
  gwApp.use('/*', gateway.middleware);
  gwApp.all('/*', async (c) => {
    const url = new URL(c.req.url);
    const target = `http://localhost:${BACKEND_PORT}${url.pathname}${url.search}`;
    const res = await fetch(target, { method: c.req.method });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
    });
  });

  const gw = serve({ fetch: gwApp.fetch, port: GATEWAY_PORT, hostname: '0.0.0.0' }, () => {
    console.log(`[gateway] L402 gateway on :${GATEWAY_PORT} → :${BACKEND_PORT}`);
  });

  console.log(`  Gateway init: ${elapsed(tGatewayInit)}`);

  // --- 3. Initialize payer wallet (Ryan's funded wallet) ---
  console.log('\nInitializing payer wallet...');
  const tPayerInit = Date.now();

  const payerSigner = MockSigner.fromSecretKey(Buffer.from(PAYER_KEY, 'hex'));
  const payerWallet = await GolemWallet.create(payerSigner, { ...MUTINYNET_CONFIG, dataDir: './data' });

  const payerSwapProvider = new BoltzSwapProvider({
    apiUrl: BOLTZ_API,
    network: 'mutinynet',
    referralId: 'golem',
  });

  const payerLightning = new ArkadeLightning({
    wallet: payerWallet.sdkWallet,
    swapProvider: payerSwapProvider,
    swapManager: { enableAutoActions: true },
  });

  await payerLightning.startSwapManager();

  console.log(`  Payer init: ${elapsed(tPayerInit)}`);

  // --- Check payer balance ---
  const balance = await payerWallet.getBalance();
  console.log(`\nPayer balance: ${JSON.stringify(balance)}`);

  if (balance.total <= 0 && balance.available <= 0) {
    console.error('\nSTOP: Payer wallet has no funds. Fund it before running this test.');
    backend.close();
    gw.close();
    await gatewayLightning.dispose();
    await payerLightning.dispose();
    process.exit(1);
  }

  console.log(`  Available: ${balance.available} sats`);

  await sleep(1000);

  // --- 4. Request /v1/aqi → expect 402 ---
  console.log('\n--- Step 1: Request without payment ---');
  const tChallenge = Date.now();

  const challengeRes = await fetch(`http://localhost:${GATEWAY_PORT}/v1/aqi?lat=45.52&lng=-122.68`);
  const challengeBody = await challengeRes.json();

  console.log(`  Status: ${challengeRes.status}`);
  console.log(`  Challenge received: ${elapsed(tChallenge)}`);

  if (challengeRes.status !== 402) {
    console.error('Expected 402, got', challengeRes.status);
    process.exit(1);
  }

  const macaroon = challengeBody.macaroon;
  const invoice = challengeBody.invoice;
  const paymentHash = challengeBody.paymentHash;

  console.log(`  Invoice: ${invoice.slice(0, 60)}...`);
  console.log(`  Payment hash: ${paymentHash}`);

  // --- 5. Pay the invoice from payer wallet ---
  console.log('\n--- Step 2: Pay invoice via Lightning ---');
  const tPayment = Date.now();

  console.log('  Sending Lightning payment...');
  const payResult = await payerLightning.sendLightningPayment({ invoice });

  console.log(`  Payment complete: ${elapsed(tPayment)}`);
  console.log(`  Preimage: ${payResult.preimage}`);
  console.log(`  Txid: ${payResult.txid}`);

  // --- 6. Retry with L402 token ---
  console.log('\n--- Step 3: Retry with L402 token ---');
  const tRetry = Date.now();

  const authHeader = `L402 ${macaroon}:${payResult.preimage}`;
  const paidRes = await fetch(`http://localhost:${GATEWAY_PORT}/v1/aqi?lat=45.52&lng=-122.68`, {
    headers: { 'Authorization': authHeader },
  });
  const paidBody = await paidRes.json();

  console.log(`  Status: ${paidRes.status}`);
  console.log(`  Verification + proxy: ${elapsed(tRetry)}`);
  console.log(`  Response: ${JSON.stringify(paidBody)}`);

  // --- Results ---
  const totalTime = Date.now() - t0;

  console.log('\n=== Timing Summary ===');
  console.log(`  Challenge (402):      ${elapsed(tChallenge)}`);
  console.log(`  Lightning payment:    ${elapsed(tPayment)}`);
  console.log(`  Verification (200):   ${elapsed(tRetry)}`);
  console.log(`  Total round-trip:     ${totalTime.toLocaleString()}ms`);

  console.log('\n=== Result ===');
  if (paidRes.status === 200 && paidBody.aqi === 42) {
    console.log('PASS: Full L402 flow with real Lightning payment succeeded.');
  } else {
    console.log(`FAIL: Expected 200 with AQI data, got ${paidRes.status}`);
  }

  console.log('\nGateway stats:', JSON.stringify(gateway.stats));

  // Check payer balance after
  const balanceAfter = await payerWallet.getBalance();
  console.log(`Payer balance after: ${JSON.stringify(balanceAfter)}`);

  // Cleanup
  backend.close();
  gw.close();
  await gatewayLightning.dispose();
  await payerLightning.dispose();

  process.exit(paidRes.status === 200 ? 0 : 1);
}

main().catch((err) => {
  console.error('Live payment test failed:', err);
  process.exit(1);
});
