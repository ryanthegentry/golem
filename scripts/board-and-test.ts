// EventSource polyfill for Node.js (Ark SDK uses SSE for batch rounds)
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { MockSigner } from '../src/signer/mock-signer.js';
import { GolemWallet } from '../src/wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../src/wallet/config.js';
import { getNetworkConfig } from '../src/config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

/**
 * Workaround for SDK race condition: the SDK registers the intent
 * BEFORE connecting to SSE, so the batch_started event can be missed.
 *
 * Fix: monkey-patch arkProvider.registerIntent to add a small delay,
 * giving the SSE connection time to establish.
 */
function patchSettleRace(wallet: GolemWallet): void {
  const provider = wallet.sdkWallet.arkProvider as any;
  const originalRegister = provider.registerIntent.bind(provider);
  provider.registerIntent = async (intent: any) => {
    // Give SSE connection time to establish before registering
    await new Promise(r => setTimeout(r, 2000));
    return originalRegister(intent);
  };
}

async function main() {
  // Same deterministic key as get-boarding-address.ts
  const secret = new Uint8Array(32);
  secret[0] = 0xDE; secret[1] = 0xAD; secret[2] = 0xBE; secret[3] = 0xEF;
  secret[31] = 0x01;

  const signer = MockSigner.fromSecretKey(secret);
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: null });

  // Check balance before boarding
  const balanceBefore = await wallet.getBalance();
  console.log('Balance before boarding:', JSON.stringify(balanceBefore));

  // Check boarding UTXOs
  const boardingUtxos = await wallet.getBoardingUtxos();
  console.log('Boarding UTXOs:', boardingUtxos.length);

  if (boardingUtxos.length === 0) {
    console.log('No boarding UTXOs found. Fund the boarding address first.');
    return;
  }

  // Board into Ark
  console.log('\nBoarding into Ark...');
  // Apply race condition fix
  patchSettleRace(wallet);

  try {
    const txid = await wallet.settle(undefined);
    console.log('\nBoarding txid:', txid);
  } catch (err: any) {
    console.error('\nBoarding failed:', err.message || err);
    return;
  }

  // Check balance after boarding
  const balanceAfter = await wallet.getBalance();
  console.log('\nBalance after boarding:', JSON.stringify(balanceAfter));

  // Check VTXOs
  const vtxos = await wallet.getVtxos();
  console.log('VTXOs:', vtxos.length);
  for (const vtxo of vtxos) {
    console.log(`  - value=${vtxo.value} state=${vtxo.virtualStatus?.state} expiry=${vtxo.virtualStatus?.batchExpiry}`);
  }

  // Check expiring VTXOs
  const expiring = await wallet.getExpiringVtxos();
  console.log('Expiring VTXOs:', expiring.length);
}

main().catch(console.error);
