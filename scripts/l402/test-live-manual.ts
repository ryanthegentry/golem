/**
 * L402 Gateway — Automated live Lightning payment test.
 *
 * Full end-to-end L402 flow with REAL Lightning on mutinynet.
 *
 * Three-step liquidity setup:
 *   Step 0a: Keysend LND → faucet node (creates inbound liquidity for LND)
 *   Step 0b: Ark wallet → submarine swap → LND invoice (gives Boltz ARK liquidity)
 *   Step 0c: Verify both directions have liquidity
 *
 * L402 test:
 *   Step 1: Gateway (Ark wallet) creates invoice via Boltz reverse swap
 *   Step 2: Voltage LND pays the invoice (LND → Boltz → Ark)
 *   Step 3: L402 macaroon + preimage verified, upstream data returned
 *
 * Run: npx tsx src/l402/test-live-manual.ts
 */

// EventSource polyfill — MUST be set before any SDK imports
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { randomBytes, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../wallet/config.js';
import { getNetworkConfig } from '../config/networks.js';
import { createL402Gateway } from './gateway.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

const BACKEND_PORT = 3097;
const GATEWAY_PORT = 8497;
const BOLTZ_API = 'https://api.boltz.mutinynet.arkade.sh';

// Funded Ark wallet key
const PAYER_KEY = 'e0f60aacd061005ae3e59d0540af2caafbcb895212c180c2c1b8813a49d61d1e';

// Voltage LND node on mutinynet
const LND_REST_URL = process.env.VOLTAGE_LND_URL || 'https://golem-tester.u.voltageapp.io:8080';
const LND_MACAROON_BASE64 = process.env.VOLTAGE_MACAROON;
if (!LND_MACAROON_BASE64) {
  console.error('VOLTAGE_MACAROON env var required (base64-encoded LND admin macaroon)');
  process.exit(1);
}
const LND_MACAROON_HEX = Buffer.from(LND_MACAROON_BASE64, 'base64').toString('hex');

// Faucet node pubkey (LND's channel partner)
const FAUCET_PUBKEY = '02465ed5be53d04fde66c9418ff14a5f2267723810176c9212b722e542dc1afb1b';

// Amounts — keysend must cover rebalance + L402 + channel reserve (~3333) + fees
const KEYSEND_SATS = 25_000;    // Drain from LND to create inbound
const REBALANCE_SATS = 5_000;   // Ark→LND to give Boltz ARK liquidity
const L402_PRICE_SATS = 1_000;  // L402 gateway price

function elapsed(start: number): string {
  return `${(Date.now() - start).toLocaleString()}ms`;
}

function lndHeaders(): Record<string, string> {
  return { 'Grpc-Metadata-macaroon': LND_MACAROON_HEX, 'Content-Type': 'application/json' };
}

/** Get LND channel balance info. */
async function getLndBalance(): Promise<{ local: number; remote: number }> {
  const res = await fetch(`${LND_REST_URL}/v1/channels`, {
    headers: { 'Grpc-Metadata-macaroon': LND_MACAROON_HEX },
  });
  const data = await res.json();
  const ch = data.channels?.[0];
  return {
    local: parseInt(ch?.local_balance || '0', 10),
    remote: parseInt(ch?.remote_balance || '0', 10),
  };
}

/** Keysend payment from LND to a destination node. */
async function keysendFromLnd(destPubkey: string, amountSats: number): Promise<void> {
  // Generate random preimage for keysend
  const preimage = randomBytes(32);
  const paymentHash = createHash('sha256').update(preimage).digest();

  // Keysend TLV record: key 5482373484 = preimage
  const destPubkeyBase64 = Buffer.from(destPubkey, 'hex').toString('base64');
  const preimageBase64 = preimage.toString('base64');
  const paymentHashBase64 = paymentHash.toString('base64');

  // Use v2 router send for keysend support
  const res = await fetch(`${LND_REST_URL}/v2/router/send`, {
    method: 'POST',
    headers: lndHeaders(),
    body: JSON.stringify({
      dest: destPubkeyBase64,
      amt: String(amountSats),
      payment_hash: paymentHashBase64,
      dest_custom_records: {
        '5482373484': preimageBase64,
      },
      timeout_seconds: 60,
      fee_limit_sat: '100',
    }),
  });

  // v2/router/send is a streaming endpoint — read all chunks
  const text = await res.text();

  // Parse the last JSON object from the stream (newline-delimited)
  const lines = text.trim().split('\n');
  for (const line of lines.reverse()) {
    try {
      const obj = JSON.parse(line);
      // Check the result field
      if (obj.result?.status === 'SUCCEEDED') {
        return; // Success
      }
      if (obj.result?.status === 'FAILED') {
        throw new Error(`Keysend failed: ${obj.result.failure_reason || 'unknown'}`);
      }
      if (obj.result?.payment_error) {
        throw new Error(`Keysend error: ${obj.result.payment_error}`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue; // Skip non-JSON lines
      throw e;
    }
  }

  throw new Error(`Keysend: unexpected response: ${text.slice(0, 200)}`);
}

/** Create a Lightning invoice on Voltage LND. */
async function createLndInvoice(amountSats: number, memo: string): Promise<{ invoice: string; paymentHash: string }> {
  const res = await fetch(`${LND_REST_URL}/v1/invoices`, {
    method: 'POST',
    headers: lndHeaders(),
    body: JSON.stringify({ value: String(amountSats), memo }),
  });

  if (!res.ok) throw new Error(`LND create invoice failed: ${res.status} ${await res.text()}`);

  const body = await res.json();
  const paymentHash = Buffer.from(body.r_hash, 'base64').toString('hex');
  return { invoice: body.payment_request, paymentHash };
}

/** Pay a Lightning invoice via Voltage LND REST API. Returns preimage as hex. */
async function payInvoiceViaLnd(invoice: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(`${LND_REST_URL}/v1/channels/transactions`, {
      method: 'POST',
      headers: lndHeaders(),
      body: JSON.stringify({
        payment_request: invoice,
        fee_limit: { fixed: '100' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`LND API returned ${res.status}: ${await res.text()}`);

    const body = await res.json();
    if (body.payment_error) throw new Error(`LND payment error: ${body.payment_error}`);

    return Buffer.from(body.payment_preimage, 'base64').toString('hex');
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const t0 = Date.now();
  console.log('=== L402 Automated Live Payment Test ===\n');
  console.log('  Three-step liquidity setup, then L402 end-to-end.\n');

  // --- Preflight ---
  console.log('--- Preflight ---\n');
  const bal0 = await getLndBalance();
  console.log(`  LND channel: ${bal0.local} local / ${bal0.remote} remote sats`);

  if (bal0.local < KEYSEND_SATS + L402_PRICE_SATS + 1000) {
    console.error(`  ERROR: LND needs >= ${KEYSEND_SATS + L402_PRICE_SATS + 1000} local sats`);
    process.exit(1);
  }

  // ========================================
  // STEP 0a: Keysend LND → faucet node
  // Creates inbound liquidity for LND
  // Channel reserve is ~3333 sats, so we need extra headroom.
  // ========================================
  console.log('\n--- Step 0a: Keysend LND → faucet node ---\n');
  const tKeysend = Date.now();

  // Calculate how much inbound we need: rebalance + L402 + reserve + buffer
  const CHANNEL_RESERVE = 3_400; // slightly above 3333
  const inboundNeeded = REBALANCE_SATS + L402_PRICE_SATS + CHANNEL_RESERVE + 500;
  const keysendAmount = Math.max(0, inboundNeeded - bal0.remote);

  if (keysendAmount > 0) {
    console.log(`  Current inbound: ${bal0.remote} sats`);
    console.log(`  Need: ${inboundNeeded} sats (${REBALANCE_SATS} rebalance + ${L402_PRICE_SATS} L402 + ${CHANNEL_RESERVE} reserve + 500 buffer)`);
    console.log(`  Keysending ${keysendAmount} sats to faucet node...`);
    await keysendFromLnd(FAUCET_PUBKEY, keysendAmount);
  } else {
    console.log(`  Inbound liquidity sufficient: ${bal0.remote} sats (need ${inboundNeeded})`);
    console.log('  Skipping keysend.');
  }

  const bal1 = await getLndBalance();
  console.log(`  Keysend step: ${elapsed(tKeysend)}`);
  console.log(`  LND channel: ${bal1.local} local / ${bal1.remote} remote sats`);

  if (bal1.remote < inboundNeeded) {
    console.error(`  ERROR: Still not enough inbound (need ${inboundNeeded}, have ${bal1.remote})`);
    process.exit(1);
  }

  // ========================================
  // STEP 0b: Ark wallet → submarine swap → LND
  // Gives Boltz ARK liquidity for reverse swaps
  // ========================================
  console.log('\n--- Step 0b: Ark wallet → submarine swap → LND ---\n');
  const tRebalance = Date.now();

  // Initialize Ark wallet
  const signer = MockSigner.fromSecretKey(Buffer.from(PAYER_KEY, 'hex'));
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: './data' });

  const arkBalance = await wallet.getBalance();
  console.log(`  Ark balance: ${arkBalance.total} sats (${arkBalance.available} available)`);

  if (arkBalance.available < REBALANCE_SATS + L402_PRICE_SATS + 1000) {
    console.error(`  ERROR: Ark wallet needs >= ${REBALANCE_SATS + L402_PRICE_SATS + 1000} available sats`);
    process.exit(1);
  }

  const swapProvider = new BoltzSwapProvider({
    apiUrl: BOLTZ_API,
    network: 'mutinynet',
    referralId: 'golem',
  });

  const lightning = new ArkadeLightning({
    wallet: wallet.sdkWallet,
    swapProvider,
    swapManager: { enableAutoActions: true },
  });

  await lightning.startSwapManager();

  // Create LND invoice and pay it from Ark wallet
  console.log(`  Creating ${REBALANCE_SATS} sat invoice on LND...`);
  const rebalanceInvoice = await createLndInvoice(REBALANCE_SATS, 'Boltz ARK liquidity rebalance');
  console.log(`  Invoice: ${rebalanceInvoice.invoice.slice(0, 60)}...`);

  console.log('  Paying via submarine swap (Ark → Boltz → LND)...');
  const rebalanceResult = await lightning.sendLightningPayment({ invoice: rebalanceInvoice.invoice });
  console.log(`  Submarine swap complete: ${elapsed(tRebalance)}`);
  console.log(`  Preimage: ${rebalanceResult.preimage}`);

  // ========================================
  // STEP 0c: Verify liquidity
  // ========================================
  console.log('\n--- Step 0c: Liquidity check ---\n');
  const bal2 = await getLndBalance();
  const arkBalance2 = await wallet.getBalance();
  console.log(`  LND channel: ${bal2.local} local / ${bal2.remote} remote sats`);
  console.log(`  Ark balance: ${arkBalance2.available} available sats`);
  console.log('  Boltz now has ARK liquidity from the submarine swap.');
  console.log('  LND has inbound liquidity from the keysend.');
  console.log('  Ready for L402 test.\n');

  // ========================================
  // STEP 1: Start backend + L402 gateway
  // ========================================
  console.log('--- Step 1: Starting servers ---\n');

  // Mock backend
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
    console.log(`  Backend on :${BACKEND_PORT}`);
  });

  // L402 gateway (Ark wallet creates invoices via Boltz reverse swap)
  const gateway = createL402Gateway(lightning, {
    priceSats: L402_PRICE_SATS,
    description: 'BreatheLocal API — 1000 sats per request',
    freePaths: ['/health', '/stats'],
  });

  const gwApp = new Hono();
  gwApp.get('/health', (c) => c.json({ status: 'ok' }));
  gwApp.get('/stats', (c) => c.json(gateway.stats));
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
    console.log(`  Gateway on :${GATEWAY_PORT}`);
  });

  // ========================================
  // STEP 2: Get 402 challenge
  // ========================================
  console.log('\n--- Step 2: Getting 402 challenge ---\n');
  const tChallenge = Date.now();

  const challengeRes = await fetch(`http://localhost:${GATEWAY_PORT}/v1/aqi?lat=45.52&lng=-122.68`);
  const challengeBody = await challengeRes.json();

  if (challengeRes.status !== 402) {
    console.error(`  Expected 402, got ${challengeRes.status}`);
    process.exit(1);
  }

  console.log(`  Status: ${challengeRes.status}`);
  console.log(`  Challenge time: ${elapsed(tChallenge)}`);
  console.log(`  Price: ${challengeBody.price} sats`);
  console.log(`  Payment hash: ${challengeBody.paymentHash}`);
  console.log(`  Invoice: ${challengeBody.invoice.slice(0, 80)}...`);

  const macaroon = challengeBody.macaroon;

  // ========================================
  // STEP 3: Pay invoice from Voltage LND
  // LND → Boltz reverse swap → Ark wallet
  // ========================================
  console.log('\n--- Step 3: Paying invoice via Voltage LND ---\n');
  const tPayment = Date.now();

  console.log('  Sending payment (LND → Boltz → Ark wallet)...');
  const preimage = await payInvoiceViaLnd(challengeBody.invoice);

  console.log(`  Payment complete: ${elapsed(tPayment)}`);
  console.log(`  Preimage: ${preimage}`);

  // ========================================
  // STEP 4: Authenticated request with L402 token
  // ========================================
  console.log('\n--- Step 4: Authenticated request ---\n');
  const tVerify = Date.now();

  const authHeader = `L402 ${macaroon}:${preimage}`;
  const paidRes = await fetch(`http://localhost:${GATEWAY_PORT}/v1/aqi?lat=45.52&lng=-122.68`, {
    headers: { 'Authorization': authHeader },
  });
  const paidBody = await paidRes.json();

  console.log(`  Status: ${paidRes.status}`);
  console.log(`  Verify time: ${elapsed(tVerify)}`);
  console.log(`  Response: ${JSON.stringify(paidBody, null, 2)}`);

  // ========================================
  // STEP 5: Summary
  // ========================================
  console.log('\n--- Step 5: Summary ---\n');

  const statsRes = await fetch(`http://localhost:${GATEWAY_PORT}/stats`);
  const stats = await statsRes.json();
  const balFinal = await getLndBalance();
  const arkFinal = await wallet.getBalance();

  console.log(`  Total time:          ${elapsed(t0)}`);
  console.log(`  Keysend drain:       ${KEYSEND_SATS} sats (LND → faucet)`);
  console.log(`  Boltz rebalance:     ${REBALANCE_SATS} sats (Ark → LND)`);
  console.log(`  L402 payment:        ${L402_PRICE_SATS} sats (LND → Ark)`);
  console.log(`  Payment hash:        ${challengeBody.paymentHash}`);
  console.log(`  Preimage:            ${preimage}`);
  console.log(`  Auth request status: ${paidRes.status}`);
  console.log(`  Gateway stats:       ${JSON.stringify(stats)}`);
  console.log(`  LND final:           ${balFinal.local} local / ${balFinal.remote} remote`);
  console.log(`  Ark final:           ${arkFinal.available} available sats`);

  const pass = paidRes.status === 200 && paidBody.aqi === 42;

  if (pass) {
    console.log('\n  PASS: Full L402 flow with real Lightning payment succeeded.');
    console.log('        Keysend: LND → faucet (inbound liquidity)');
    console.log('        Submarine: Ark → Boltz → LND (ARK liquidity)');
    console.log('        Reverse: LND → Boltz → Ark (L402 payment)');
    console.log('        Macaroon + preimage verified, upstream data returned.');
  } else {
    console.log(`\n  FAIL: Expected 200 with AQI data, got ${paidRes.status}`);
  }

  // Cleanup
  backend.close();
  gw.close();
  await lightning.dispose();

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
