/**
 * golem balance — Show wallet balance and address
 */

import { Command } from 'commander';
import { getWallet } from '../wallet.js';
import { isBlockHeight, normalizeExpiryMs, getNearestExpiryMs, toExpiryInput } from '../../agent/expiry.js';

export const balanceCommand = new Command('balance')
  .description('Show wallet balance')
  .option('--verbose', 'Show VTXO details (count, expiry, addresses)')
  .action(async (opts) => {
    console.log('Connecting to Ark server...');
    const { wallet, config } = await getWallet();
    const balance = await wallet.getBalance();
    const address = await wallet.getAddress();
    const boardingAddress = await wallet.getBoardingAddress();

    console.log('');
    console.log(`  Network:    ${config.network}`);
    console.log(`  Ark addr:   ${address}`);
    console.log(`  Boarding:   ${boardingAddress}`);
    if (config.safeHarborAddress) {
      console.log(`  Safe harbor: ${config.safeHarborAddress}`);
    }
    console.log('');
    console.log(`  Total:      ${balance.total.toLocaleString()} sats`);
    console.log(`  Available:  ${balance.available.toLocaleString()} sats`);
    console.log(`  Settled:    ${balance.settled.toLocaleString()} sats`);
    console.log(`  Boarding:   ${balance.boarding.total.toLocaleString()} sats`);

    if (opts.verbose) {
      const vtxos = await wallet.getVtxos();
      console.log('');
      console.log(`  VTXOs: ${vtxos.length}`);

      if (vtxos.length > 0) {
        const now = Date.now();

        console.log('');
        for (const vtxo of vtxos) {
          const expiry = vtxo.virtualStatus.batchExpiry;
          let expiryStr = 'unknown';
          if (expiry && expiry > 0 && !isBlockHeight(expiry)) {
            const expiryMs = normalizeExpiryMs(expiry);
            const remainingMs = expiryMs - now;
            if (remainingMs > 0) {
              const hours = remainingMs / (3600 * 1000);
              const days = Math.floor(hours / 24);
              const remHours = Math.floor(hours % 24);
              expiryStr = days > 0 ? `${days}d ${remHours}h` : `${remHours}h`;
              expiryStr += ` (${new Date(expiryMs).toISOString()})`;
            } else {
              expiryStr = 'EXPIRED';
            }
          }
          console.log(`    ${vtxo.txid.slice(0, 12)}:${vtxo.vout}  ${vtxo.value.toLocaleString().padStart(10)} sats  ${vtxo.virtualStatus.state.padEnd(12)}  expires: ${expiryStr}`);
        }

        const nearestMs = getNearestExpiryMs(toExpiryInput(vtxos));
        if (nearestMs !== null) {
          const nearestHours = nearestMs / (3600 * 1000);
          const nearestDays = Math.floor(nearestHours / 24);
          const remHours = Math.floor(nearestHours % 24);
          const nearestStr = nearestDays > 0 ? `${nearestDays}d ${remHours}h` : `${Math.floor(nearestHours)}h`;
          console.log('');
          console.log(`  Nearest expiry: ${nearestStr}`);
        }
      }
    }
  });
