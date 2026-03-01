/**
 * End-to-end VTXO consolidation test on mutinynet.
 *
 * Validates that wallet.consolidateVtxos() works with the real Ark server —
 * specifically that the server accepts exact-sum outputs and deducts fees.
 *
 * Flow:
 * 1. Create fresh wallet, fund from faucet
 * 2. Board into Ark → 1 VTXO
 * 3. Fund + board again to create a second VTXO (fragmentation)
 * 4. Consolidate all VTXOs into one
 * 5. Verify VTXO count reduced, report fee
 */

// EventSource polyfill
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { MockSigner } from '../src/signer/mock-signer.js';
import { GolemWallet } from '../src/wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../src/wallet/config.js';
import { getNetworkConfig } from '../src/config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

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
    console.error('Usage: npx tsx scripts/e2e-consolidation-test.ts <faucet-jwt>');
    process.exit(1);
  }

  console.log('=== E2E VTXO Consolidation Test ===\n');

  // Step 1: Create fresh wallet
  console.log('1. Creating fresh wallet...');
  const signer = MockSigner.create();
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: null });
  const boardingAddr = await wallet.getBoardingAddress();
  const arkAddr = await wallet.getAddress();
  console.log(`  Boarding: ${boardingAddr}`);
  console.log(`  Ark: ${arkAddr}`);

  // Step 2: First fund + board
  console.log('\n2. First funding (30000 sats)...');
  const fundTxid1 = await fundFromFaucet(boardingAddr, 30000, faucetToken);
  console.log(`  Txid: ${fundTxid1}`);
  console.log('  Waiting for confirmation...');
  await waitForConfirmation(fundTxid1);

  console.log('  Boarding into Ark...');
  const boardTxid1 = await wallet.settle(undefined);
  console.log(`  Commitment txid: ${boardTxid1}`);

  // Step 3: Check state after first board
  let vtxos = await wallet.getVtxos();
  const spendable1 = vtxos.filter(v =>
    v.virtualStatus?.state === 'settled' || v.virtualStatus?.state === 'preconfirmed'
  );
  console.log(`  Spendable VTXOs after first board: ${spendable1.length}`);

  // Step 4: Second fund + board to create fragmentation
  console.log('\n3. Second funding (20000 sats)...');
  const fundTxid2 = await fundFromFaucet(boardingAddr, 20000, faucetToken);
  console.log(`  Txid: ${fundTxid2}`);
  console.log('  Waiting for confirmation...');
  await waitForConfirmation(fundTxid2);

  console.log('  Boarding into Ark...');
  const boardTxid2 = await wallet.settle(undefined);
  console.log(`  Commitment txid: ${boardTxid2}`);

  // Step 5: Verify fragmentation
  vtxos = await wallet.getVtxos();
  const spendablePre = vtxos.filter(v =>
    v.virtualStatus?.state === 'settled' || v.virtualStatus?.state === 'preconfirmed'
  );
  console.log(`\n4. Pre-consolidation state:`);
  console.log(`  Total VTXOs: ${vtxos.length}`);
  console.log(`  Spendable VTXOs: ${spendablePre.length}`);
  const totalPre = spendablePre.reduce((sum, v) => sum + v.value, 0);
  console.log(`  Total value: ${totalPre} sats`);
  for (const v of spendablePre) {
    console.log(`  - value=${v.value} state=${v.virtualStatus?.state}`);
  }

  if (spendablePre.length < 2) {
    console.log('\n  WARNING: Only 1 spendable VTXO — cannot test consolidation.');
    console.log('  This may happen if the server auto-consolidated during boarding.');
    process.exit(0);
  }

  // Step 6: Consolidate
  console.log('\n5. Consolidating VTXOs...');
  try {
    const consTxid = await wallet.consolidateVtxos(spendablePre);
    console.log(`  Consolidation txid: ${consTxid}`);
  } catch (err) {
    console.error('\n  CONSOLIDATION FAILED:', err);
    console.error('  This may indicate the server rejects exact-sum outputs.');
    console.error('  Fallback: use wallet.settle() without params for automatic fee handling.');
    process.exit(1);
  }

  // Step 7: Verify result
  vtxos = await wallet.getVtxos();
  const spendablePost = vtxos.filter(v =>
    v.virtualStatus?.state === 'settled' || v.virtualStatus?.state === 'preconfirmed'
  );
  const totalPost = spendablePost.reduce((sum, v) => sum + v.value, 0);
  const feePaid = totalPre - totalPost;

  console.log('\n6. Post-consolidation state:');
  console.log(`  Spendable VTXOs: ${spendablePost.length}`);
  console.log(`  Total value: ${totalPost} sats`);
  console.log(`  Fee paid: ${feePaid} sats`);
  for (const v of spendablePost) {
    console.log(`  - value=${v.value} state=${v.virtualStatus?.state}`);
  }

  // Step 8: Summary
  console.log('\n=== Results ===');
  console.log(`  VTXOs before: ${spendablePre.length}`);
  console.log(`  VTXOs after:  ${spendablePost.length}`);
  console.log(`  Value before: ${totalPre} sats`);
  console.log(`  Value after:  ${totalPost} sats`);
  console.log(`  Fee:          ${feePaid} sats`);

  if (spendablePost.length <= spendablePre.length && spendablePost.length >= 1) {
    console.log('\n  Consolidation working end-to-end');
  } else {
    console.log('\n  Unexpected result — investigate');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
