/**
 * Ark OOR payment mode for `golem pay`.
 *
 * Sends sats to an Ark address via off-round (OOR) transaction.
 */

import { getWallet, exitWithError } from '../wallet.js';

/** Send sats to an Ark address via OOR. */
export async function payArkAddress(address: string, amountStr: string | undefined): Promise<void> {
  if (!amountStr) {
    exitWithError('Amount required for Ark address payments. Usage: golem pay <ark1...address> <amount_sats>');
  }

  const amount = parseInt(amountStr, 10);
  if (isNaN(amount) || amount <= 0) {
    exitWithError('Amount must be a positive integer (sats).');
  }

  console.log('Connecting to Ark server...');
  const { wallet } = await getWallet();

  console.log(`Sending ${amount.toLocaleString()} sats to ${address.slice(0, 30)}...`);
  const startTime = Date.now();

  try {
    const txid = await wallet.sendBitcoin({ address, amount });
    const duration = Date.now() - startTime;

    console.log(`\nPayment sent!`);
    console.log(`  Txid:     ${txid}`);
    console.log(`  Amount:   ${amount.toLocaleString()} sats`);
    console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`);

    const balance = await wallet.getBalance();
    console.log(`  Balance:  ${balance.total.toLocaleString()} sats`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    exitWithError(msg);
  }

  process.exit(0); // Force exit — SwapManager WebSocket cleanup hangs
}
