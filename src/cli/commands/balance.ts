/**
 * golem balance — Show wallet balance and address
 */

import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createWalletFromConfig } from '../wallet.js';

export const balanceCommand = new Command('balance')
  .description('Show wallet balance')
  .action(async () => {
    const config = loadConfig();

    console.log('Connecting to Ark server...');
    const wallet = await createWalletFromConfig(config);
    const balance = await wallet.getBalance();
    const address = await wallet.getAddress();

    console.log('');
    console.log(`  Network:    ${config.network}`);
    console.log(`  Address:    ${address}`);
    console.log('');
    console.log(`  Total:      ${balance.total.toLocaleString()} sats`);
    console.log(`  Available:  ${balance.available.toLocaleString()} sats`);
    console.log(`  Settled:    ${balance.settled.toLocaleString()} sats`);
    console.log(`  Boarding:   ${balance.boarding.total.toLocaleString()} sats`);
  });
