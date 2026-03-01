/**
 * Q1 + Q3: Boltz Reverse Swap Lifecycle & Timeout Analysis
 *
 * Creates a reverse swap and examines:
 * - Full response structure (including timeout block heights)
 * - Swap status monitoring without claiming
 * - Whether VTXOs appear in ReadonlyWallet without claim
 *
 * If VOLTAGE_MACAROON is set, also pays the invoice to test the
 * paid-but-unclaimed scenario.
 */

import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;
import { ReadonlySingleKey, ReadonlyWallet, RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

const PUBKEY_HEX = '03a29419fa1e8167c16f1f848310595fe850096d9bed10b3a14ea93d64834267b4';
const ARK_SERVER = 'https://mutinynet.arkade.sh';
const BOLTZ_API = 'https://api.boltz.mutinynet.arkade.sh';
const VOLTAGE_API = 'https://golem-tester.u.voltageapp.io:8080';

async function main() {
  console.log('=== Q1 + Q3: Boltz Reverse Swap Lifecycle ===\n');

  // Setup ReadonlyWallet
  console.log('1. Setting up ReadonlyWallet + ArkadeLightning...');
  const pubkey = Buffer.from(PUBKEY_HEX, 'hex');
  const readonlyIdentity = ReadonlySingleKey.fromPublicKey(pubkey);
  const readonlyWallet = await ReadonlyWallet.create({
    identity: readonlyIdentity,
    arkServerUrl: ARK_SERVER,
  });

  const swapProvider = new BoltzSwapProvider({
    apiUrl: BOLTZ_API,
    network: 'mutinynet',
    referralId: 'golem',
  });

  const arkProvider = new RestArkProvider(ARK_SERVER);
  const indexerProvider = new RestIndexerProvider(ARK_SERVER);

  // @ts-expect-error — ReadonlyWallet not in type union
  const arkadeLightning = new ArkadeLightning({
    wallet: readonlyWallet,
    swapProvider,
    arkProvider,
    indexerProvider,
  });

  // Record initial state
  const initialBalance = await readonlyWallet.getBalance();
  const initialVtxos = await readonlyWallet.getVtxos();
  console.log('   Initial balance:', initialBalance.total, 'sats');
  console.log('   Initial VTXOs:', initialVtxos.length);

  // Create reverse swap
  console.log('\n2. Creating reverse swap (1000 sats)...');
  const result = await arkadeLightning.createLightningInvoice({ amount: 1000 });
  console.log('   Swap ID:', result.pendingSwap.id);
  console.log('   Invoice:', result.invoice.slice(0, 60) + '...');
  console.log('   Payment hash:', result.paymentHash);
  console.log('   Preimage:', result.preimage);
  console.log('   Amount (after Boltz fee):', result.amount, 'sats');

  // Q3: Examine timeout block heights from response
  console.log('\n3. TIMEOUT ANALYSIS (Q3):');
  const response = result.pendingSwap.response;
  console.log('   Full response keys:', Object.keys(response));
  console.log('   Lockup address:', response.lockupAddress);
  console.log('   Refund pubkey:', response.refundPublicKey);

  if (response.timeoutBlockHeights) {
    const t = response.timeoutBlockHeights;
    console.log('   Timeout block heights:');
    console.log('     refund:', t.refund);
    console.log('     unilateralClaim:', t.unilateralClaim);
    console.log('     unilateralRefund:', t.unilateralRefund);
    console.log('     unilateralRefundWithoutReceiver:', t.unilateralRefundWithoutReceiver);

    // On mutinynet, blocks are ~30 seconds
    console.log('   Estimated timeouts (mutinynet, ~30s blocks):');
    console.log('     refund:', Math.round(t.refund * 30 / 60), 'minutes (~', Math.round(t.refund * 30 / 3600), 'hours)');
    console.log('     unilateralClaim:', Math.round(t.unilateralClaim * 30 / 60), 'minutes');
    console.log('     unilateralRefund:', Math.round(t.unilateralRefund * 30 / 60), 'minutes');

    // On mainnet, blocks are ~10 minutes
    console.log('   Estimated timeouts (mainnet, ~10min blocks):');
    console.log('     refund:', Math.round(t.refund * 10 / 60), 'hours (~', Math.round(t.refund * 10 / 1440), 'days)');
    console.log('     unilateralClaim:', Math.round(t.unilateralClaim * 10 / 60), 'hours');
    console.log('     unilateralRefund:', Math.round(t.unilateralRefund * 10 / 60), 'hours');
  } else {
    console.log('   WARNING: No timeoutBlockHeights in response');
    console.log('   Full response:', JSON.stringify(response, null, 2));
  }

  // Q1: Check swap status via Boltz API
  console.log('\n4. Checking initial Boltz swap status...');
  try {
    const statusResp = await fetch(`${BOLTZ_API}/v2/swap/${result.pendingSwap.id}`);
    const status = await statusResp.json();
    console.log('   Boltz swap status:', JSON.stringify(status, null, 2));
  } catch (e: any) {
    console.log('   Could not fetch swap status:', e.message);
  }

  // Get Boltz fee info
  console.log('\n5. Boltz fee and limit info...');
  try {
    const fees = await swapProvider.getFees();
    console.log('   Reverse swap fees:', JSON.stringify(fees.reverse, null, 2));
    const limits = await swapProvider.getLimits();
    console.log('   Reverse swap limits:', JSON.stringify(limits.reverse, null, 2));
  } catch (e: any) {
    console.log('   Could not fetch fees/limits:', e.message);
  }

  // Full pending swap data (Q4: what would need to be persisted)
  console.log('\n6. PENDING SWAP DATA (Q4 - what to persist for deferred claiming):');
  const swap = result.pendingSwap;
  console.log('   Keys:', Object.keys(swap));
  console.log('   id:', swap.id);
  console.log('   type:', swap.type);
  console.log('   createdAt:', swap.createdAt);
  console.log('   preimage:', swap.preimage);
  console.log('   status:', swap.status);
  console.log('   request keys:', Object.keys(swap.request));
  console.log('   request.claimPublicKey:', swap.request.claimPublicKey);
  console.log('   request.preimageHash:', swap.request.preimageHash);
  console.log('   response keys:', Object.keys(swap.response));

  // Check if VOLTAGE_MACAROON is available for live payment test
  const voltageMacaroon = process.env.VOLTAGE_MACAROON;
  if (voltageMacaroon) {
    console.log('\n7. LIVE PAYMENT TEST (VOLTAGE_MACAROON available)...');
    await runLivePaymentTest(result, readonlyWallet, swapProvider, voltageMacaroon);
  } else {
    console.log('\n7. SKIP: VOLTAGE_MACAROON not set. Set it to run the live payment test.');
    console.log('   Without live payment, swap will expire at status swap.created');
    console.log('   The key test (paid-but-unclaimed) requires actual Lightning payment');
  }

  // Check wallet state (whether VTXOs appeared without claiming)
  console.log('\n8. Checking wallet state after swap creation (no payment, no claim)...');
  const postBalance = await readonlyWallet.getBalance();
  const postVtxos = await readonlyWallet.getVtxos();
  console.log('   Balance changed:', postBalance.total !== initialBalance.total);
  console.log('   VTXO count changed:', postVtxos.length !== initialVtxos.length);
  console.log('   Current balance:', postBalance.total, 'sats');
  console.log('   Current VTXOs:', postVtxos.length);

  console.log('\n=== RESULTS ===');
  console.log('BOLTZ REVERSE SWAP TIMEOUT:');
  if (response.timeoutBlockHeights) {
    const t = response.timeoutBlockHeights;
    console.log(`- Timeout type: block heights`);
    console.log(`- Refund timeout: ${t.refund} blocks`);
    console.log(`- Unilateral claim timeout: ${t.unilateralClaim} blocks`);
    console.log(`- Mutinynet (~30s blocks): refund in ~${Math.round(t.refund * 30 / 60)} min`);
    console.log(`- Mainnet (~10min blocks): refund in ~${Math.round(t.refund * 10 / 60)} hours`);
  }
  console.log(`- What happens at timeout if unclaimed: Boltz can refund via refund path`);

  process.exit(0);
}

async function runLivePaymentTest(
  invoiceResult: any,
  readonlyWallet: ReadonlyWallet,
  _swapProvider: BoltzSwapProvider,
  voltageMacaroon: string,
) {
  const macaroonHex = Buffer.from(voltageMacaroon, 'base64').toString('hex');

  // Pay the invoice from Voltage LND
  console.log('   Paying invoice from Voltage LND...');
  try {
    const payResp = await fetch(`${VOLTAGE_API}/v1/channels/transactions`, {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': macaroonHex,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payment_request: invoiceResult.invoice,
        fee_limit: { fixed: '100' },
      }),
    });
    const payResult = await payResp.json();
    console.log('   Payment result:', JSON.stringify(payResult).slice(0, 200));

    if (payResult.payment_error) {
      console.log('   Payment FAILED:', payResult.payment_error);
      return;
    }

    console.log('   Payment SUCCEEDED');
    console.log('   Preimage from LND:', payResult.payment_preimage || 'PENDING (hold invoice)');

    // Check if LND has the preimage (if hold invoice, it won't until claim)
    const hasPreimage = !!payResult.payment_preimage && payResult.payment_preimage !== '';
    console.log('   LND received preimage immediately:', hasPreimage ? 'YES' : 'NO (hold invoice)');

    // Wait a few seconds for Boltz to process
    console.log('   Waiting 5s for Boltz to process...');
    await new Promise(r => setTimeout(r, 5000));

    // Check Boltz swap status after payment
    console.log('   Checking Boltz swap status after payment...');
    const statusResp = await fetch(`${BOLTZ_API}/v2/swap/${invoiceResult.pendingSwap.id}`);
    const status = await statusResp.json();
    console.log('   Boltz status:', JSON.stringify(status, null, 2));

    // Check ReadonlyWallet state
    console.log('   Checking ReadonlyWallet after payment (no claim)...');
    const balance = await readonlyWallet.getBalance();
    const vtxos = await readonlyWallet.getVtxos();
    console.log('   Balance:', balance.total, 'sats');
    console.log('   VTXOs:', vtxos.length);

    // Check if notification fires (set up listener, wait briefly)
    let notificationReceived = false;
    const stopFn = await readonlyWallet.notifyIncomingFunds((funds) => {
      notificationReceived = true;
      console.log('   NOTIFICATION: Incoming funds detected!', funds.type);
    });

    await new Promise(r => setTimeout(r, 10000));
    console.log('   Notification received in 10s:', notificationReceived ? 'YES' : 'NO');
    if (typeof stopFn === 'function') stopFn();

    // Wait longer and re-check
    console.log('   Waiting 30s more, then re-checking...');
    await new Promise(r => setTimeout(r, 30000));

    const laterStatus = await fetch(`${BOLTZ_API}/v2/swap/${invoiceResult.pendingSwap.id}`);
    console.log('   Boltz status after 35s:', JSON.stringify(await laterStatus.json(), null, 2));

    const laterBalance = await readonlyWallet.getBalance();
    const laterVtxos = await readonlyWallet.getVtxos();
    console.log('   Balance after 35s:', laterBalance.total, 'sats');
    console.log('   VTXOs after 35s:', laterVtxos.length);

  } catch (e: any) {
    console.log('   Payment error:', e.message);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
