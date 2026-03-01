/**
 * golem pay — Multi-mode payment command.
 *
 * Three modes detected from the target argument:
 * 1. Ark address (ark1.../tark1...): OOR send to Ark address
 * 2. Lightning invoice (lnbc.../lntbs.../lntb...): Pay via Boltz submarine swap
 * 3. URL (http/https): L402 client — pay for access to an L402-gated URL
 */

import { Command } from 'commander';
import { payArkAddress } from './pay-ark.js';
import { payLightningInvoice } from './pay-lightning.js';
import { payL402Url } from './pay-l402.js';

/** Detect what kind of target the user passed. */
function detectTargetType(target: string): 'ark' | 'lightning' | 'url' {
  if (target.startsWith('ark1') || target.startsWith('tark1')) return 'ark';
  if (target.startsWith('lnbc') || target.startsWith('lntbs') || target.startsWith('lntb')) return 'lightning';
  return 'url';
}

export const payCommand = new Command('pay')
  .description('Send sats to an Ark address, pay a Lightning invoice, or access an L402 URL')
  .argument('<target>', 'Ark address (ark1.../tark1...), Lightning invoice (lnbc...), or URL')
  .argument('[amount]', 'Amount in sats (required for Ark address payments)')
  .option('--max-price <sats>', 'Maximum price to pay for L402 (sats)', '10000')
  .option('--method <method>', 'HTTP method for L402 requests', 'GET')
  .option('--header <headers...>', 'Additional headers for L402 (key:value)')
  .option('--lightning', 'Force Lightning payment for L402 (skip Ark OOR)')
  .option('--ark', 'Force Ark OOR payment for L402 (fail if unavailable)')
  .action(async (target: string, amount: string | undefined, opts) => {
    const mode = detectTargetType(target);

    switch (mode) {
      case 'ark':
        await payArkAddress(target, amount);
        break;
      case 'lightning':
        await payLightningInvoice(target);
        break;
      case 'url':
        await payL402Url(target, opts);
        break;
      default:
        throw new Error(`Unknown payment target type: ${mode}`);
    }
  });
