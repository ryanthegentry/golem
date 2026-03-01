/**
 * Q6 + Q7: Lightning HTLC Lifecycle + ReadonlyWallet VTXO Observation
 *
 * LIVE TEST: Creates a reverse swap, pays it from Voltage LND,
 * does NOT call waitAndClaim(), and observes:
 * - Lightning payment status
 * - Boltz swap status transitions
 * - ReadonlyWallet balance/VTXO changes
 * - notifyIncomingFunds notifications
 *
 * Requires VOLTAGE_MACAROON env var (hex or base64).
 */

import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;
import { ReadonlySingleKey, ReadonlyWallet, RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

const PUBKEY_HEX = '03a29419fa1e8167c16f1f848310595fe850096d9bed10b3a14ea93d64834267b4';
const ARK_SERVER = 'https://mutinynet.arkade.sh';
const BOLTZ_API = 'https://api.boltz.mutinynet.arkade.sh';
const VOLTAGE_API = 'https://golem-tester.u.voltageapp.io:8080';

function getMacaroonHex(): string {
  const raw = process.env.VOLTAGE_MACAROON || '';
  // If it looks like hex (all hex chars), use directly
  if (/^[0-9a-f]+$/i.test(raw)) return raw;
  // Handle base64url (replace - → +, _ → /) then decode as base64
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('hex');
}

async function lndRequest(path: string, method = 'GET', body?: any) {
  const macaroonHex = getMacaroonHex();
  const opts: any = {
    method,
    headers: {
      'Grpc-Metadata-macaroon': macaroonHex,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${VOLTAGE_API}${path}`, opts);
  return resp.json();
}

async function getBoltzStatus(swapId: string) {
  const resp = await fetch(`${BOLTZ_API}/v2/swap/${swapId}`);
  return resp.json();
}

async function main() {
  console.log('=== Q6 + Q7: Lightning HTLC Lifecycle & VTXO Observation ===\n');

  // Verify LND is reachable
  console.log('0. Checking Voltage LND connectivity...');
  try {
    const info = await lndRequest('/v1/getinfo');
    console.log('   LND alias:', info.alias);
    console.log('   LND synced:', info.synced_to_chain);
  } catch (e: any) {
    console.log('   FAILED to reach LND:', e.message);
    console.log('   Set VOLTAGE_MACAROON env var');
    process.exit(1);
  }

  // Setup ReadonlyWallet
  console.log('\n1. Setting up ReadonlyWallet + ArkadeLightning...');
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

  // @ts-expect-error
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

  // Set up notification listener BEFORE swap
  let notifications: any[] = [];
  console.log('\n2. Setting up notifyIncomingFunds listener...');
  const stopNotify = await readonlyWallet.notifyIncomingFunds((funds) => {
    const ts = new Date().toISOString();
    notifications.push({ ts, type: funds.type });
    if (funds.type === 'vtxo') {
      console.log(`     New VTXOs: ${funds.newVtxos.length}, Spent VTXOs: ${funds.spentVtxos.length}`);
    }
  });

  // Create reverse swap
  console.log('\n3. Creating reverse swap (1000 sats)...');
  const result = await arkadeLightning.createLightningInvoice({ amount: 1000 });
  const swapId = result.pendingSwap.id;
  console.log('   Swap ID:', swapId);
  console.log('   Invoice:', result.invoice.slice(0, 60) + '...');
  console.log('   Payment hash:', result.paymentHash);
  console.log('   Preimage (gateway has this):', result.preimage?.slice(0, 16) + '...');
  console.log('   Timeout block heights:', JSON.stringify(result.pendingSwap.response.timeoutBlockHeights));

  // Check initial Boltz status
  const status0 = await getBoltzStatus(swapId);
  console.log('   Initial Boltz status:', status0.status);

  // PAY THE INVOICE from Voltage LND (but do NOT call waitAndClaim)
  console.log('\n4. Paying invoice from Voltage LND...');
  console.log('   (This is a hold invoice — payment will be PENDING until claim)');

  // Send payment (hold invoices may not return immediately)
  const payPromise = lndRequest('/v1/channels/transactions', 'POST', {
    payment_request: result.invoice,
    fee_limit: { fixed: '100' },
  });

  // Don't await — hold invoice may block until settlement
  // Instead, poll Boltz status
  console.log('   Payment request sent (may block on hold invoice)...');

  // Monitor Boltz status transitions
  console.log('\n5. Monitoring Boltz swap status (NOT calling waitAndClaim)...');
  const startTime = Date.now();
  let lastStatus = '';
  let statusHistory: { ts: string; status: string; elapsed: number }[] = [];

  for (let i = 0; i < 24; i++) { // Check every 5s for 2 minutes
    await new Promise(r => setTimeout(r, 5000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    try {
      const status = await getBoltzStatus(swapId);
      if (status.status !== lastStatus) {
        statusHistory.push({ ts: new Date().toISOString(), status: status.status, elapsed });
        lastStatus = status.status;

        // Dump full status on change
        console.log('   Full status:', JSON.stringify(status, null, 2));
      }
    } catch (e: any) {
      // Status check failed silently
    }

    // Check wallet state
    const bal = await readonlyWallet.getBalance();
    const vtxos = await readonlyWallet.getVtxos();
    if (bal.total !== initialBalance.total || vtxos.length !== initialVtxos.length) {
      console.log(`     Balance: ${initialBalance.total} → ${bal.total}`);
      console.log(`     VTXOs: ${initialVtxos.length} → ${vtxos.length}`);
    }

    // If status is terminal, stop
    if (['invoice.settled', 'invoice.expired', 'swap.expired',
         'transaction.failed', 'transaction.refunded'].includes(lastStatus)) {
      console.log(`   Terminal status reached: ${lastStatus}`);
      break;
    }
  }

  // Check LND payment result (may have resolved by now)
  console.log('\n6. Checking LND payment result...');
  try {
    const payResult = await Promise.race([
      payPromise,
      new Promise(resolve => setTimeout(() => resolve({ status: 'TIMEOUT' }), 5000)),
    ]);
    console.log('   LND payment result:', JSON.stringify(payResult).slice(0, 300));

    if ((payResult as any).payment_preimage) {
      console.log('   LND received preimage: YES');
      console.log('   Preimage:', (payResult as any).payment_preimage);
    } else if ((payResult as any).payment_error) {
      console.log('   LND payment error:', (payResult as any).payment_error);
    } else if ((payResult as any).status === 'TIMEOUT') {
      console.log('   LND payment still pending (hold invoice — no claim yet)');
    }
  } catch (e: any) {
    console.log('   LND result error:', e.message);
  }

  // Final wallet state
  console.log('\n7. Final wallet state (no claim performed):');
  const finalBalance = await readonlyWallet.getBalance();
  const finalVtxos = await readonlyWallet.getVtxos();
  console.log('   Balance:', finalBalance.total, 'sats (was', initialBalance.total, ')');
  console.log('   VTXOs:', finalVtxos.length, '(was', initialVtxos.length, ')');
  console.log('   Balance changed:', finalBalance.total !== initialBalance.total);
  console.log('   VTXOs changed:', finalVtxos.length !== initialVtxos.length);

  // Notification summary
  console.log('\n8. Notification summary:');
  console.log('   Total notifications received:', notifications.length);
  for (const n of notifications) {
    console.log(`   - [${n.ts}] ${n.type}`);
  }

  // Cleanup
  if (typeof stopNotify === 'function') stopNotify();

  console.log('\n=== CONSOLIDATED RESULTS ===');
  console.log('');
  console.log('Q6: LIGHTNING HTLC LIFECYCLE:');
  console.log('- Status transitions:', statusHistory.map(s => s.status).join(' → '));
  console.log('- Hold invoice: LND payment pending until claim? Check result above');
  console.log('- If hold: Boltz holds HTLC, cannot settle without preimage');
  console.log('- Preimage revealed: ONLY when claim happens on Ark');
  console.log('- If unclaimed: HTLC times out → consumer refunded on Lightning');
  console.log('- Who ends up with money: NOBODY (Boltz refunds both sides)');
  console.log('');
  console.log('Q7: READONLY WALLET VTXO OBSERVATION:');
  console.log('- VTXOs appeared without claim:', finalVtxos.length !== initialVtxos.length ? 'YES' : 'NO');
  console.log('- Balance changed without claim:', finalBalance.total !== initialBalance.total ? 'YES' : 'NO');
  console.log('- Notifications received:', notifications.length > 0 ? 'YES' : 'NO');
  console.log('- VHTLC is at lockup address, NOT user address');
  console.log('  → ReadonlyWallet queries its OWN scripts');
  console.log('  → VHTLC has a DIFFERENT script (Boltz lockup)');
  console.log('  → Expected: VTXOs do NOT appear until claimed');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
