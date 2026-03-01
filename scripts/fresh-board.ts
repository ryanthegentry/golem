// EventSource polyfill
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { MockSigner } from '../src/signer/mock-signer.js';
import { GolemWallet } from '../src/wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../src/wallet/config.js';
import { getNetworkConfig } from '../src/config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  // Fresh random signer
  const signer = MockSigner.create();
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: null });

  const boardingAddr = await wallet.getBoardingAddress();
  console.log('Boarding address:', boardingAddr);

  // Fund from faucet
  console.log('Funding from faucet...');
  const faucetToken = process.argv[2];
  if (!faucetToken) {
    console.error('Usage: npx tsx scripts/fresh-board.ts <faucet-jwt>');
    process.exit(1);
  }

  const res = await fetch('https://faucet.mutinynet.com/api/onchain', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${faucetToken}`,
    },
    body: JSON.stringify({ address: boardingAddr, sats: 50000 }),
  });
  const fundResult = await res.json();
  console.log('Fund result:', fundResult);

  if (!fundResult.txid) {
    console.error('Funding failed');
    return;
  }

  // Wait for confirmation
  console.log('Waiting for confirmation...');
  for (let i = 0; i < 20; i++) {
    const statusRes = await fetch(`https://mutinynet.com/api/tx/${fundResult.txid}/status`);
    const txStatus = await statusRes.json() as any;
    if (txStatus.confirmed) {
      console.log('Confirmed at block', txStatus.block_height);
      break;
    }
    await sleep(5000);
  }

  // Verify balance
  const balance = await wallet.getBalance();
  console.log('Balance:', JSON.stringify(balance));

  const boardingUtxos = await wallet.getBoardingUtxos();
  console.log('Boarding UTXOs:', boardingUtxos.length);

  if (boardingUtxos.length === 0) {
    console.log('No boarding UTXOs found after funding.');
    return;
  }

  // Board into Ark
  console.log('\nBoarding...');
  try {
    const txid = await wallet.settle(undefined);
    console.log('\nSUCCESS! txid:', txid);

    // Check final state
    const finalBalance = await wallet.getBalance();
    console.log('Final balance:', JSON.stringify(finalBalance));

    const vtxos = await wallet.getVtxos();
    console.log('VTXOs:', vtxos.length);
    for (const v of vtxos) {
      console.log(`  - value=${v.value} state=${v.virtualStatus?.state}`);
    }
  } catch (err: any) {
    console.error('\nFAILED:', err.message);
  }

  process.exit(0);
}

main().catch(console.error);
