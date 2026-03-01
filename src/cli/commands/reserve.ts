/**
 * golem reserve — Show on-chain reserve balance vs required
 */

import { Command } from 'commander';
import { getWallet } from '../wallet.js';

export const reserveCommand = new Command('reserve')
  .description('Show on-chain reserve balance vs required')
  .action(async () => {
    console.log('Connecting to Ark server...');
    const { wallet, config } = await getWallet();

    const reserve = await wallet.getRequiredReserve();
    const actual = await wallet.getOnchainReserveBalance();
    const ocw = await wallet.getOrCreateOnchainWallet();

    console.log('');
    console.log('On-chain reserve (for AnchorBumper fee-bump during unilateral exit):');
    console.log('');
    console.log(`  P2TR address:  ${ocw.address}`);
    console.log(`  Balance:       ${actual.toLocaleString()} sats`);
    console.log(`  Required:      ${reserve.required.toLocaleString()} sats`);
    console.log(`  VTXO count:    ${reserve.vtxoCount}`);
    console.log(`  Per-VTXO:      ${reserve.perVtxo.toLocaleString()} sats`);
    console.log(`  Config target: ${config.onchainReserveSats.toLocaleString()} sats`);
    console.log('');

    if (reserve.vtxoCount === 0) {
      console.log('  No VTXOs — no reserve needed.');
    } else if (actual >= reserve.required) {
      console.log(`  STATUS: OK (${(actual - reserve.required).toLocaleString()} sats surplus)`);
    } else {
      const deficit = reserve.required - actual;
      console.log(`  STATUS: LOW — send ${deficit.toLocaleString()} sats to the P2TR address above.`);
    }
  });
