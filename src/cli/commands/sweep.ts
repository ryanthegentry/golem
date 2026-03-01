/**
 * golem sweep — Sweep excess balance to the safe harbor address.
 *
 * Sends all balance above a specified threshold to the safe harbor address.
 * golem sweep --keep 10000 sweeps everything except 10,000 sats.
 */

import { Command } from 'commander';
import { getWallet, exitWithError } from '../wallet.js';

export const sweepCommand = new Command('sweep')
  .description('Sweep excess balance to safe harbor address')
  .option('--keep <sats>', 'Keep this many sats in the wallet (sweep the rest)', '10000')
  .option('--dry-run', 'Show what would be swept without executing')
  .action(async (opts) => {
    const keepSats = parseInt(opts.keep, 10);

    if (isNaN(keepSats) || keepSats < 0) {
      exitWithError('--keep must be a non-negative number of satoshis.');
    }

    const { wallet, config } = await getWallet();

    if (!config.safeHarborAddress) {
      exitWithError('No safe harbor address configured. Run `golem safe-harbor --set <address>` first.');
    }
    const balance = await wallet.getBalance();

    const available = balance.available;
    const sweepAmount = available - keepSats;

    console.log('');
    console.log(`  Balance:       ${available.toLocaleString()} sats`);
    console.log(`  Keep:          ${keepSats.toLocaleString()} sats`);
    console.log(`  Sweep amount:  ${sweepAmount.toLocaleString()} sats`);
    console.log(`  Destination:   ${config.safeHarborAddress}`);

    if (sweepAmount <= 0) {
      console.log('');
      console.log('Nothing to sweep — balance is at or below the keep threshold.');
      return;
    }

    if (opts.dryRun) {
      console.log('');
      console.log('(dry run — no transaction sent)');
      return;
    }

    console.log('');

    try {
      const txid = await wallet.sendBitcoin({
        address: config.safeHarborAddress,
        amount: sweepAmount,
      });

      console.log(`  Txid: ${txid}`);
      console.log(`  Sent: ${sweepAmount.toLocaleString()} sats to ${config.safeHarborAddress}`);
      console.log(`  Kept: ${keepSats.toLocaleString()} sats in wallet`);
    } catch (err) {
      exitWithError(`Sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  });
