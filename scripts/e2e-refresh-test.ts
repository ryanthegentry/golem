/**
 * End-to-end VTXO lifecycle test:
 * 1. Create wallet, fund from faucet, board into Ark
 * 2. Verify VTXOs exist and have expiry
 * 3. Run refresh agent tick
 * 4. Report results
 */

// EventSource polyfill
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { MockSigner } from '../src/signer/mock-signer.js';
import { GolemWallet } from '../src/wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../src/wallet/config.js';
import { getNetworkConfig } from '../src/config/networks.js';
import { RefreshAgent } from '../src/agent/refresh-agent.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));
import type { RefreshEvent } from '../src/agent/refresh-agent.js';

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
    console.error('Usage: npx tsx scripts/e2e-refresh-test.ts <faucet-jwt>');
    process.exit(1);
  }

  console.log('=== E2E VTXO Lifecycle Test ===\n');

  // Step 1: Create fresh wallet
  console.log('1. Creating fresh wallet...');
  const signer = MockSigner.create();
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: null });
  const boardingAddr = await wallet.getBoardingAddress();
  const arkAddr = await wallet.getAddress();
  console.log(`  Boarding: ${boardingAddr}`);
  console.log(`  Ark: ${arkAddr}`);

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

  // Step 4: Verify VTXOs
  console.log('\n4. Checking wallet state...');
  const balance = await wallet.getBalance();
  console.log(`  Balance: ${JSON.stringify(balance)}`);

  const vtxos = await wallet.getVtxos();
  console.log(`  VTXOs: ${vtxos.length}`);
  for (const v of vtxos) {
    const expiryDate = v.virtualStatus?.batchExpiry
      ? new Date(v.virtualStatus.batchExpiry * 1000).toISOString()
      : 'unknown';
    console.log(`  - value=${v.value} state=${v.virtualStatus?.state} expiry=${expiryDate}`);
  }

  // Step 5: Check expiring VTXOs
  console.log('\n5. Checking for expiring VTXOs...');
  const expiring = await wallet.getExpiringVtxos();
  console.log(`  Expiring VTXOs (default safety margin): ${expiring.length}`);

  // Step 6: Run refresh agent tick
  console.log('\n6. Running RefreshAgent tick...');
  const events: RefreshEvent[] = [];
  const agent = new RefreshAgent(
    wallet,
    { pollIntervalMs: 60_000, safetyMarginMs: 3 * 24 * 60 * 60 * 1000 },
    (e) => {
      events.push(e);
    },
  );

  await agent.tick();
  console.log(`  Events emitted: ${events.length}`);

  // Step 7: Summary
  console.log('\n=== Results ===');
  console.log(`  Wallet funded: YES (${balance.total} sats)`);
  console.log(`  VTXOs created: ${vtxos.length}`);
  console.log(`  Expiring VTXOs: ${expiring.length}`);
  console.log(`  Agent tick: ${events.length > 0 ? events.map(e => e.type).join(' → ') : 'no events'}`);

  if (vtxos.length > 0 && events.length > 0 && events[0].type === 'check') {
    console.log('\n  ✅ Full VTXO lifecycle working end-to-end');
  } else {
    console.log('\n  ❌ Something went wrong');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
