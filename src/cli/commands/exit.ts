/**
 * golem exit — Manually trigger safe harbor exit
 *
 * Exits ALL funds to the configured safe harbor address.
 * Requires typing "exit" to confirm (safety-critical operation).
 */

import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { getWallet, exitWithError } from '../wallet.js';
import * as readline from 'node:readline';

export const exitCommand = new Command('exit')
  .description('Emergency exit — send ALL funds to safe harbor address')
  .option('--confirm', 'Skip interactive confirmation (for automation)')
  .action(async (opts) => {
    const config = loadConfig();

    if (!config.safeHarborAddress) {
      exitWithError('No safe harbor address configured. Set one first: golem safe-harbor <bitcoin-address>');
    }

    const address = config.safeHarborAddress;

    if (!opts.confirm) {
      console.log(`This will exit ALL funds to: ${address}`);
      console.log('This action cannot be undone.');
      console.log('');

      const confirmed = await promptConfirmation('Type "exit" to confirm: ');
      if (confirmed !== 'exit') {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    console.log('Connecting to Ark server...');
    const { wallet } = await getWallet();

    const balance = await wallet.getBalance();
    console.log(`Total balance: ${balance.total.toLocaleString()} sats`);

    if (balance.total === 0) {
      console.log('Nothing to exit — balance is zero.');
      process.exit(0);
    }

    console.log(`Exiting to ${address}...`);
    console.log('Attempting cooperative offboard first...');

    try {
      const result = await wallet.exitToSafeHarbor(address, undefined, (event) => {
        if ('id' in event) {
          console.log(`  Settlement event: ${event.type}`);
        }
      });

      console.log('');
      console.log(`Exit complete!`);
      console.log(`  Method: ${result.method}`);
      console.log(`  TxID:   ${result.txid}`);
    } catch (err) {
      exitWithError(`Exit failed: ${(err as Error).message}`);
    }
  });

function promptConfirmation(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
