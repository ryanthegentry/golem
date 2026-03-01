/**
 * golem safe-harbor — Show or update safe harbor address
 *
 * Usage:
 *   golem safe-harbor              Show current safe harbor address + reserve status
 *   golem safe-harbor <address>    Update safe harbor address (validates format + network)
 */

import { Command } from 'commander';
import { loadConfig, saveConfig } from '../config.js';
import { getWallet, exitWithError } from '../wallet.js';
import { validateBitcoinAddress, type BitcoinNetwork } from '../../utils/address-validation.js';

export const safeHarborCommand = new Command('safe-harbor')
  .description('Show or update safe harbor address')
  .argument('[address]', 'New safe harbor Bitcoin address (on-chain)')
  .action(async (address?: string) => {
    const config = loadConfig();

    if (address) {
      // Update mode — validate and save
      try {
        const validated = validateBitcoinAddress(address, config.network as BitcoinNetwork);
        config.safeHarborAddress = validated.address;
        saveConfig(config);

        console.log(`Safe harbor address updated: ${validated.address}`);
        console.log(`  Type:     ${validated.type.toUpperCase()}`);
        console.log(`  Network:  ${validated.network}`);
        for (const warning of validated.warnings) {
          console.log(`  WARNING:  ${warning}`);
        }
      } catch (err) {
        exitWithError((err as Error).message);
      }
      return;
    }

    // Show mode — display current address + reserve status
    console.log(`  Network:  ${config.network}`);

    if (config.safeHarborAddress) {
      console.log(`  Address:  ${config.safeHarborAddress}`);
    } else {
      console.log('  Address:  (not set)');
      console.log('');
      console.log('  Set one with: golem safe-harbor <bitcoin-address>');
    }

    console.log(`  Exit threshold: ${config.safeHarborExitThresholdBlocks} blocks`);
    console.log(`  Reserve target: ${config.onchainReserveSats.toLocaleString()} sats`);

    // Try to get live reserve info
    try {
      console.log('');
      console.log('Connecting to Ark server...');
      const { wallet } = await getWallet();
      const reserve = await wallet.getRequiredReserve();
      const actual = await wallet.getOnchainReserveBalance();

      console.log('');
      console.log('  On-chain reserve:');
      console.log(`    Actual:    ${actual.toLocaleString()} sats`);
      console.log(`    Required:  ${reserve.required.toLocaleString()} sats (${reserve.vtxoCount} VTXOs × ${reserve.perVtxo.toLocaleString()} sats)`);
      if (actual < reserve.required) {
        console.log(`    STATUS:    LOW — need ${(reserve.required - actual).toLocaleString()} more sats`);
      } else {
        console.log('    STATUS:    OK');
      }
    } catch {
      // Non-fatal — wallet may not be connectable
    }
  });
