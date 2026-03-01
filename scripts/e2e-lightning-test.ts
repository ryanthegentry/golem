/**
 * End-to-end Lightning onboarding test on mutinynet:
 * 1. Create wallet, fund from faucet, board into Ark
 * 2. Create GolemLightning, check limits/fees
 * 3. Create a Lightning invoice
 * 4. Print invoice for manual payment (automated claim requires a paying wallet)
 *
 * Usage: npx tsx scripts/e2e-lightning-test.ts <faucet-jwt>
 */

// EventSource polyfill
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { MockSigner } from '../src/signer/mock-signer.js';
import { GolemWallet } from '../src/wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../src/wallet/config.js';
import { lightningConfigFromNetwork } from '../src/lightning/config.js';
import { getNetworkConfig } from '../src/config/networks.js';
import { GolemLightning } from '../src/lightning/golem-lightning.js';

const mutinynetConfig = getNetworkConfig('mutinynet');
const MUTINYNET_CONFIG = walletConfigFromNetwork(mutinynetConfig);
const MUTINYNET_LIGHTNING_CONFIG = lightningConfigFromNetwork(mutinynetConfig);

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function fundFromFaucet(address: string, sats: number, token: string): Promise<string> {
  const res = await fetch('https://faucet.mutinynet.com/api/onchain', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ address, sats }),
  });
  const result = await res.json() as any;
  if (!result.txid) throw new Error(`Faucet failed: ${JSON.stringify(result)}`);
  return result.txid;
}

async function waitForConfirmation(txid: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`https://mutinynet.com/api/tx/${txid}/status`);
    const txStatus = await res.json() as any;
    if (txStatus.confirmed) {
      console.log(`  Confirmed at block ${txStatus.block_height}`);
      return;
    }
    await sleep(5000);
  }
  throw new Error('Transaction not confirmed after 100s');
}

async function main() {
  const faucetToken = process.argv[2];
  if (!faucetToken) {
    console.error('Usage: npx tsx scripts/e2e-lightning-test.ts <faucet-jwt>');
    process.exit(1);
  }

  console.log('=== E2E Lightning Onboarding Test ===\n');

  // Step 1: Create fresh wallet
  console.log('1. Creating fresh wallet...');
  const signer = MockSigner.create();
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: null });
  const boardingAddr = await wallet.getBoardingAddress();
  console.log(`  Boarding: ${boardingAddr}`);

  // Step 2: Fund from faucet
  console.log('\n2. Funding from faucet (50000 sats)...');
  const fundTxid = await fundFromFaucet(boardingAddr, 50000, faucetToken);
  console.log(`  Txid: ${fundTxid}`);
  console.log('  Waiting for confirmation...');
  await waitForConfirmation(fundTxid);

  // Step 3: Board into Ark
  console.log('\n3. Boarding into Ark...');
  const boardTxid = await wallet.settle(undefined);
  console.log(`  Commitment txid: ${boardTxid}`);

  // Step 4: Verify Ark balance
  console.log('\n4. Checking wallet state...');
  const balance = await wallet.getBalance();
  console.log(`  Balance: ${JSON.stringify(balance)}`);

  const vtxos = await wallet.getVtxos();
  console.log(`  VTXOs: ${vtxos.length}`);

  // Step 5: Create GolemLightning
  console.log('\n5. Creating GolemLightning...');
  const lightning = new GolemLightning(wallet, MUTINYNET_LIGHTNING_CONFIG);

  // Step 6: Check limits and fees
  console.log('\n6. Checking Boltz limits and fees...');
  const limits = await lightning.getLimits();
  console.log(`  Limits: min=${limits.min} sats, max=${limits.max} sats`);

  const fees = await lightning.getFees();
  console.log(`  Reverse swap fees: ${fees.reverse.percentage}% + ${JSON.stringify(fees.reverse.minerFees)} miner sats`);
  console.log(`  Submarine swap fees: ${fees.submarine.percentage}% + ${fees.submarine.minerFees} miner sats`);

  // Step 7: Create a Lightning invoice
  const invoiceAmount = Math.max(10000, limits.min);
  console.log(`\n7. Creating Lightning invoice for ${invoiceAmount} sats...`);
  const invoice = await lightning.createInvoice(invoiceAmount);
  console.log(`  Swap ID: ${invoice.swapId}`);
  console.log(`  Payment hash: ${invoice.paymentHash}`);
  console.log(`  Expires at: ${new Date(invoice.expiresAt * 1000).toISOString()}`);
  console.log(`\n  BOLT11 invoice (pay this from any Lightning wallet):`);
  console.log(`  ${invoice.bolt11}`);

  // Step 8: Wait for payment (with timeout for automated testing)
  console.log('\n8. Waiting for Lightning payment (60s timeout)...');
  console.log('  Pay the invoice above from any Lightning wallet to complete the test.');

  try {
    const claimResult = await Promise.race([
      lightning.waitAndClaim(invoice),
      sleep(60_000).then(() => {
        throw new Error('Timeout: no payment received within 60s');
      }),
    ]);

    console.log(`  Claimed! Txid: ${(claimResult as { txid: string }).txid}`);

    // Step 9: Verify updated balance
    const newBalance = await wallet.getBalance();
    console.log(`\n9. Updated balance: ${JSON.stringify(newBalance)}`);

    console.log('\n  OK: Full Lightning onboarding working end-to-end');
  } catch (err: any) {
    if (err.message.includes('Timeout')) {
      console.log('  Timed out (expected in automated testing — no Lightning wallet to pay).');
      console.log('\n  OK: Invoice creation and Boltz API connectivity verified');
    } else {
      throw err;
    }
  }

  // Cleanup
  await lightning.dispose();

  console.log('\n=== Results ===');
  console.log(`  Wallet funded: YES (${balance.total} sats)`);
  console.log(`  VTXOs: ${vtxos.length}`);
  console.log(`  Boltz API: connected (limits ${limits.min}-${limits.max} sats)`);
  console.log(`  Invoice created: ${invoice.swapId}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
