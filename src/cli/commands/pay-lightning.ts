/**
 * Lightning payment mode for `golem pay`.
 *
 * Pays a Lightning invoice via Boltz submarine swap (Ark -> Boltz -> Lightning).
 */

import { getWallet, exitWithError } from '../wallet.js';
import { getDataDir } from '../config.js';
import { getNetworkConfig } from '../../config/networks.js';
import { createLightning } from '../../lightning/index.js';

/** Pay a Lightning invoice via Boltz submarine swap. */
export async function payLightningInvoice(invoice: string): Promise<void> {
  console.log('Connecting to Ark server...');
  const { wallet, config } = await getWallet();

  const netConfig = getNetworkConfig(config.network);
  const lightning = await createLightning(wallet.sdkWallet, netConfig, getDataDir());

  console.log(`Paying Lightning invoice (Ark → Boltz → Lightning)...`);
  console.log(`  Invoice: ${invoice.slice(0, 60)}...`);
  const startTime = Date.now();

  try {
    const result = await lightning.sendLightningPayment({ invoice });
    const duration = Date.now() - startTime;

    console.log(`\nPayment sent!`);
    console.log(`  Preimage: ${result.preimage.slice(0, 8)}...`);
    console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`);

    const balance = await wallet.getBalance();
    console.log(`  Balance:  ${balance.total.toLocaleString()} sats`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    exitWithError(msg);
  }

  process.exit(0); // Force exit — SwapManager WebSocket cleanup hangs
}
