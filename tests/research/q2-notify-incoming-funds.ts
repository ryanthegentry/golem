/**
 * Q2: Does notifyIncomingFunds() work on ReadonlyWallet?
 *
 * Tests whether ReadonlyWallet supports real-time fund notifications
 * and whether waitForIncomingFunds() works with it.
 */

import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;
import { ReadonlySingleKey, ReadonlyWallet, waitForIncomingFunds } from '@arkade-os/sdk';

const PUBKEY_HEX = '03a29419fa1e8167c16f1f848310595fe850096d9bed10b3a14ea93d64834267b4';
const ARK_SERVER = 'https://mutinynet.arkade.sh';

async function main() {
  console.log('=== Q2: ReadonlyWallet Notification Capabilities ===\n');

  // Create ReadonlyWallet
  console.log('1. Creating ReadonlyWallet...');
  const pubkey = Buffer.from(PUBKEY_HEX, 'hex');
  const readonlyIdentity = ReadonlySingleKey.fromPublicKey(pubkey);
  const readonlyWallet = await ReadonlyWallet.create({
    identity: readonlyIdentity,
    arkServerUrl: ARK_SERVER,
  });
  console.log('   ReadonlyWallet created');

  // Check method availability
  console.log('\n2. Checking notification method availability...');
  const hasNotify = typeof readonlyWallet.notifyIncomingFunds === 'function';
  console.log('   notifyIncomingFunds() available:', hasNotify ? 'YES' : 'NO');

  // Test notifyIncomingFunds
  if (hasNotify) {
    console.log('\n3. Testing notifyIncomingFunds()...');
    try {
      const stopFunc = await readonlyWallet.notifyIncomingFunds((funds) => {
        console.log('   Incoming funds event:', funds.type);
        if (funds.type === 'vtxo') {
          console.log('   New VTXOs:', funds.newVtxos.length);
          console.log('   Spent VTXOs:', funds.spentVtxos.length);
        } else {
          console.log('   Coins:', funds.coins.length);
        }
      });
      console.log('   notifyIncomingFunds() accepted ReadonlyWallet — no error');
      console.log('   Stop function returned:', typeof stopFunc === 'function' ? 'YES' : 'NO');

      // Wait briefly to see if it stays connected
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log('   Subscription active for 3s — no errors');

      // Stop the subscription
      if (typeof stopFunc === 'function') {
        stopFunc();
        console.log('   Subscription stopped');
      }
    } catch (error: any) {
      console.log('   FAILURE:', error.message);
    }
  }

  // Test waitForIncomingFunds (standalone function)
  console.log('\n4. Testing waitForIncomingFunds() standalone function...');
  try {
    // @ts-expect-error — type says Wallet, but ReadonlyWallet has the method
    const promise = waitForIncomingFunds(readonlyWallet);
    console.log('   waitForIncomingFunds() accepted ReadonlyWallet (no immediate error)');

    // Don't actually wait — just verify it doesn't throw
    const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), 3000));
    const result = await Promise.race([promise, timeout]);
    console.log('   Result after 3s:', result === 'timeout' ? 'Timeout (expected)' : 'Funds received');
  } catch (error: any) {
    console.log('   FAILURE:', error.message);
  }

  // Test polling fallback
  console.log('\n5. Testing polling via getBalance() / getVtxos()...');
  try {
    const balance = await readonlyWallet.getBalance();
    console.log('   getBalance() works: YES');
    console.log('   Balance:', JSON.stringify(balance));

    const vtxos = await readonlyWallet.getVtxos();
    console.log('   getVtxos() works: YES');
    console.log('   VTXO count:', vtxos.length);
  } catch (error: any) {
    console.log('   FAILURE:', error.message);
  }

  console.log('\n=== RESULTS ===');
  console.log('READONLY WALLET NOTIFICATIONS:');
  console.log('- notifyIncomingFunds() available: check above');
  console.log('- waitForIncomingFunds() works with ReadonlyWallet: check above');
  console.log('- Polling via getBalance()/getVtxos(): check above');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
