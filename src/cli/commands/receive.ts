/**
 * golem receive <amount> — Generate a Lightning invoice to receive sats into the Ark wallet.
 *
 * Uses Boltz reverse swap: payer sends Lightning → Boltz → claimed as Ark VTXO.
 * SwapManager with enableAutoActions ensures crash recovery — if the process dies
 * after payment but before claim, restarting picks up automatically.
 */

import { Command } from 'commander';
import { getWallet, exitWithError } from '../wallet.js';
import { getDataDir } from '../config.js';
import { getNetworkConfig } from '../../config/networks.js';
import { createLightning } from '../../lightning/index.js';

export const receiveCommand = new Command('receive')
  .description('Generate a Lightning invoice to receive sats')
  .argument('<amount>', 'Amount in sats to receive')
  .option('--timeout <seconds>', 'Max wait for payment (seconds)', '600')
  .action(async (amountArg: string, opts) => {
    const amount = parseInt(amountArg, 10);
    if (isNaN(amount) || amount <= 0) {
      exitWithError('Amount must be a positive integer (sats).');
    }

    const timeoutSec = parseInt(opts.timeout, 10);
    if (isNaN(timeoutSec) || timeoutSec <= 0) {
      exitWithError('Timeout must be a positive integer (seconds).');
    }

    console.log('Connecting to Ark server...');
    const { wallet, config } = await getWallet();

    const netConfig = getNetworkConfig(config.network);
    const lightning = await createLightning(wallet.sdkWallet, netConfig, getDataDir());

    console.log(`Creating invoice for ${amount.toLocaleString()} sats...\n`);

    let result;
    try {
      result = await lightning.createLightningInvoice({ amount });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      exitWithError(`Creating invoice: ${msg}`);
    }

    console.log(`Invoice: ${result.invoice}`);
    console.log(`Amount:  ${result.amount.toLocaleString()} sats`);
    console.log(`Swap ID: ${result.pendingSwap.id}`);
    console.log(`Expiry:  ${result.expiry}s`);
    console.log('');
    console.log(`Waiting for payment (timeout: ${timeoutSec}s)...`);

    try {
      const { txid } = await Promise.race([
        lightning.waitAndClaim(result.pendingSwap),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT')), timeoutSec * 1000),
        ),
      ]);

      console.log(`\nPayment received and claimed!`);
      console.log(`  Txid: ${txid}`);

      // Show updated balance
      const balance = await wallet.getBalance();
      console.log(`  Balance: ${balance.total.toLocaleString()} sats`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'TIMEOUT') {
        exitWithError(`Timed out after ${timeoutSec}s — invoice may have expired. If the payer already sent, restart golem to resume claim.`);
      }
      exitWithError(`Claiming payment: ${msg}`);
    }

    // Force exit to avoid WebSocket cleanup hangs (same pattern as pay.ts)
    process.exit(0);
  });
