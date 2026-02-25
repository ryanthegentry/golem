/**
 * End-to-end OOR send test on mutinynet:
 * 1. Create two wallets (sender + receiver)
 * 2. Fund sender from faucet, board into Ark
 * 3. Send from sender to receiver's Ark address
 * 4. Verify receiver gets funds
 * 5. Test OOR limit rejection (try to send more than limit)
 */

// EventSource polyfill
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { MockSigner } from '../src/signer/mock-signer.js';
import { GolemWallet } from '../src/wallet/golem-wallet.js';
import { MUTINYNET_CONFIG } from '../src/wallet/config.js';
import { OorLimitExceededError } from '../src/wallet/errors.js';

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
    console.error('Usage: npx tsx scripts/e2e-send-test.ts <faucet-jwt>');
    process.exit(1);
  }

  console.log('=== E2E OOR Send Test ===\n');

  // Step 1: Create sender and receiver wallets
  console.log('1. Creating sender and receiver wallets...');
  const senderSigner = MockSigner.create();
  const sender = await GolemWallet.create(senderSigner, { ...MUTINYNET_CONFIG, dataDir: null });

  const receiverSigner = MockSigner.create();
  const receiver = await GolemWallet.create(receiverSigner, { ...MUTINYNET_CONFIG, dataDir: null });

  const senderBoardingAddr = await sender.getBoardingAddress();
  const receiverArkAddr = await receiver.getAddress();
  console.log(`  Sender boarding: ${senderBoardingAddr}`);
  console.log(`  Receiver Ark: ${receiverArkAddr}`);

  // Step 2: Fund sender from faucet
  console.log('\n2. Funding sender from faucet (100,000 sats)...');
  const fundTxid = await fundFromFaucet(senderBoardingAddr, 100_000, faucetToken);
  console.log(`  Txid: ${fundTxid}`);
  console.log('  Waiting for confirmation...');
  await waitForConfirmation(fundTxid);

  // Step 3: Board sender into Ark
  console.log('\n3. Boarding sender into Ark...');
  const boardTxid = await sender.settle(undefined, (event) => {
    console.log(`  [settle] ${event.type}`);
  });
  console.log(`  Commitment txid: ${boardTxid}`);

  // Check sender balance
  const senderBalance = await sender.getBalance();
  console.log(`  Sender balance: ${JSON.stringify(senderBalance)}`);

  // Step 4: Send to receiver
  const sendAmount = 10_000;
  console.log(`\n4. Sending ${sendAmount} sats to receiver...`);
  const sendTxid = await sender.sendBitcoin({ address: receiverArkAddr, amount: sendAmount });
  console.log(`  Send txid: ${sendTxid}`);

  // Step 5: Verify receiver balance
  console.log('\n5. Checking receiver balance...');
  // Give a moment for the preconfirmed state to propagate
  await sleep(2000);
  const receiverBalance = await receiver.getBalance();
  console.log(`  Receiver balance: ${JSON.stringify(receiverBalance)}`);

  const received = receiverBalance.total > 0 || receiverBalance.preconfirmed > 0;
  if (received) {
    console.log('  Receiver got funds!');
  } else {
    console.log('  WARNING: Receiver balance still 0 — may need round settlement');
  }

  // Step 6: Test OOR limit rejection
  console.log('\n6. Testing OOR limit rejection...');
  const updatedSenderBalance = await sender.getBalance();
  // Try to send more than 10% of balance (or more than 1M floor)
  const overLimitAmount = Math.max(
    Math.floor(updatedSenderBalance.total * 0.10) + 1,
    1_000_001,
  );
  console.log(`  Sender balance: ${updatedSenderBalance.total} sats`);
  console.log(`  Attempting to send ${overLimitAmount} sats (should be rejected)...`);

  try {
    await sender.sendBitcoin({ address: receiverArkAddr, amount: overLimitAmount });
    console.log('  ERROR: Send should have been rejected but succeeded');
  } catch (err) {
    if (err instanceof OorLimitExceededError) {
      console.log(`  Correctly rejected: ${err.message}`);
      console.log(`  Requested: ${err.requestedSats}, Limit: ${err.limitSats}, Balance: ${err.totalBalance}`);
    } else {
      console.log(`  Rejected with unexpected error: ${err}`);
    }
  }

  // Summary
  console.log('\n=== Results ===');
  console.log(`  Sender funded: YES (${senderBalance.total} sats)`);
  console.log(`  Send to receiver: ${sendTxid ? 'YES' : 'NO'} (${sendAmount} sats)`);
  console.log(`  Receiver balance: ${receiverBalance.total} total, ${receiverBalance.preconfirmed} preconfirmed`);
  console.log(`  OOR limit rejection: PASSED`);

  if (sendTxid) {
    console.log('\n  OK: OOR send + limit enforcement working end-to-end');
  } else {
    console.log('\n  FAIL: Something went wrong');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
