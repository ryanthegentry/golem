/**
 * Q1 (CRITICAL): Can Boltz create Lightning invoices without the master key?
 *
 * Tests whether ArkadeLightning.createLightningInvoice() works with a
 * ReadonlyWallet (pubkey only, no signing capability).
 *
 * Expected: Invoice creation should SUCCEED (only needs compressedPublicKey).
 * Expected: waitAndClaim() would FAIL (needs sign() for VHTLC claim).
 */

import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;
import { ReadonlySingleKey, ReadonlyWallet, RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

const PUBKEY_HEX = '03a29419fa1e8167c16f1f848310595fe850096d9bed10b3a14ea93d64834267b4';
const ARK_SERVER = 'https://mutinynet.arkade.sh';
const BOLTZ_API = 'https://api.boltz.mutinynet.arkade.sh';

async function main() {
  console.log('=== Q1: Boltz Invoice Creation Without Master Key ===\n');

  // Step 1: Create ReadonlyWallet
  console.log('1. Creating ReadonlyWallet from pubkey...');
  const pubkey = Buffer.from(PUBKEY_HEX, 'hex');
  const readonlyIdentity = ReadonlySingleKey.fromPublicKey(pubkey);
  const readonlyWallet = await ReadonlyWallet.create({
    identity: readonlyIdentity,
    arkServerUrl: ARK_SERVER,
  });
  console.log('   ReadonlyWallet created successfully');

  // Verify we can get addresses (basic sanity)
  const address = await readonlyWallet.getAddress();
  console.log('   Ark address:', address.slice(0, 30) + '...');
  const boardingAddr = await readonlyWallet.getBoardingAddress();
  console.log('   Boarding address:', boardingAddr.slice(0, 30) + '...');

  // Step 2: Create Boltz swap provider
  console.log('\n2. Creating BoltzSwapProvider...');
  const swapProvider = new BoltzSwapProvider({
    apiUrl: BOLTZ_API,
    network: 'mutinynet',
    referralId: 'golem',
  });
  console.log('   BoltzSwapProvider created');

  // Step 3: Try to create ArkadeLightning with ReadonlyWallet
  // ReadonlyWallet doesn't expose arkProvider, so we provide it explicitly
  console.log('\n3. Creating ArkadeLightning with ReadonlyWallet...');
  const arkProvider = new RestArkProvider(ARK_SERVER);
  const indexerProvider = new RestIndexerProvider(ARK_SERVER);
  let arkadeLightning: ArkadeLightning;
  try {
    // @ts-expect-error — ArkadeLightningConfig.wallet expects Wallet, not ReadonlyWallet
    arkadeLightning = new ArkadeLightning({
      wallet: readonlyWallet,
      swapProvider,
      arkProvider,
      indexerProvider,
    });
    console.log('   ArkadeLightning created (no runtime error)');
  } catch (error: any) {
    console.log('   FAILURE: Cannot create ArkadeLightning with ReadonlyWallet');
    console.log('   Error:', error.message);
    process.exit(1);
  }

  // Step 4: THE CRITICAL TEST — create a Lightning invoice
  console.log('\n4. Creating Lightning invoice (1000 sats)...');
  try {
    const result = await arkadeLightning.createLightningInvoice({ amount: 1000 });
    console.log('   SUCCESS: Lightning invoice created without master key!');
    console.log('   Invoice:', result.invoice.slice(0, 60) + '...');
    console.log('   Amount:', result.amount, 'sats');
    console.log('   Payment hash:', result.paymentHash);
    console.log('   Preimage available:', !!result.preimage);
    console.log('   Swap ID:', result.pendingSwap?.id);
  } catch (error: any) {
    console.log('   FAILURE: Cannot create invoice without master key');
    console.log('   Error:', error.message);
    console.log('   Error type:', error.constructor.name);
    if (error.stack) {
      // Show relevant stack lines
      const lines = error.stack.split('\n').slice(0, 5);
      console.log('   Stack:', lines.join('\n         '));
    }
  }

  // Step 5: Verify what the ReadonlyWallet identity provides
  console.log('\n5. Checking ReadonlyIdentity capabilities...');
  const identity = readonlyWallet.identity;
  console.log('   compressedPublicKey:', typeof identity.compressedPublicKey === 'function' ? 'YES' : 'NO');
  console.log('   xOnlyPublicKey:', typeof identity.xOnlyPublicKey === 'function' ? 'YES' : 'NO');
  console.log('   sign:', typeof (identity as any).sign === 'function' ? 'YES' : 'NO');
  console.log('   signMessage:', typeof (identity as any).signMessage === 'function' ? 'YES' : 'NO');
  console.log('   signerSession:', typeof (identity as any).signerSession === 'function' ? 'YES' : 'NO');

  const compPubkey = await identity.compressedPublicKey();
  console.log('   Compressed pubkey:', Buffer.from(compPubkey).toString('hex'));

  console.log('\n=== RESULTS ===');
  console.log('BOLTZ INVOICE CREATION WITHOUT MASTER KEY:');
  console.log('- ReadonlyWallet created: YES');
  console.log('- ArkadeLightning accepts ReadonlyWallet at runtime: check above');
  console.log('- createLightningInvoice works: check above');
  console.log('- ReadonlyIdentity has compressedPublicKey: YES');
  console.log('- ReadonlyIdentity has sign: NO');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
