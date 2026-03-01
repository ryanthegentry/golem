// EventSource polyfill — MUST be set before any SDK imports
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { createHash } from 'node:crypto';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../wallet/config.js';
import { lightningConfigFromNetwork } from '../lightning/config.js';
import { getNetworkConfig } from '../config/networks.js';
import { GolemLightning } from '../lightning/golem-lightning.js';

const mutinynetConfig = getNetworkConfig('mutinynet');
const MUTINYNET_CONFIG = walletConfigFromNetwork(mutinynetConfig);
const MUTINYNET_LIGHTNING_CONFIG = lightningConfigFromNetwork(mutinynetConfig);
import { decodeInvoice, getInvoicePaymentHash } from '@arkade-os/boltz-swap';

const BOLTZ_API = 'https://api.boltz.mutinynet.arkade.sh';

async function main() {
  // --- Part 1: Swap limits ---

  console.log('=== Boltz Swap Limits ===\n');

  const [subRes, revRes] = await Promise.all([
    fetch(`${BOLTZ_API}/v2/swap/submarine`),
    fetch(`${BOLTZ_API}/v2/swap/reverse`),
  ]);

  const submarine = await subRes.json();
  const reverse = await revRes.json();

  // Submarine = Lightning → Ark (user pays LN invoice, receives Ark VTXOs)
  console.log('Submarine (Lightning → Ark):');
  const subPair = submarine?.['BTC']?.['BTC'] ?? submarine;
  console.log(`  limits: ${JSON.stringify(subPair.limits ?? subPair, null, 2)}`);

  // Reverse = Ark → Lightning (user sends Ark, gets LN payment)
  console.log('\nReverse (Ark → Lightning):');
  const revPair = reverse?.['BTC']?.['BTC'] ?? reverse;
  console.log(`  limits: ${JSON.stringify(revPair.limits ?? revPair, null, 2)}`);

  // --- Part 2: Preimage flow ---

  console.log('\n=== L402 Preimage Verification ===\n');

  // Create a throwaway wallet — we don't need funds, just the Lightning interface
  const signer = MockSigner.create();
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: null });
  const lightning = new GolemLightning(wallet, MUTINYNET_LIGHTNING_CONFIG);

  console.log('Creating Lightning invoice for 1000 sats...');
  const invoice = await lightning.createInvoice(1000);

  console.log(`\nReturned preimage:     ${invoice.pendingSwap.preimage}`);
  console.log(`Returned paymentHash:  ${invoice.paymentHash}`);

  // Verify: sha256(preimage) === paymentHash
  const preimageBytes = Buffer.from(invoice.pendingSwap.preimage, 'hex');
  const computedHash = createHash('sha256').update(preimageBytes).digest('hex');
  console.log(`Computed sha256:       ${computedHash}`);
  console.log(`Match (returned):      ${computedHash === invoice.paymentHash}`);

  // Decode the BOLT11 invoice and check its payment hash
  const decoded = decodeInvoice(invoice.bolt11);
  const invoicePaymentHash = getInvoicePaymentHash(invoice.bolt11);
  console.log(`\nInvoice payment hash:  ${invoicePaymentHash}`);
  console.log(`Match (invoice):       ${invoicePaymentHash === invoice.paymentHash}`);

  console.log(`\nInvoice amount:        ${decoded.amountSats} sats`);
  console.log(`Invoice expiry:        ${decoded.expiry}s`);
  console.log(`BOLT11 (truncated):    ${invoice.bolt11.slice(0, 60)}...`);

  // Summary
  console.log('\n=== L402 Viability ===\n');
  const allMatch = computedHash === invoice.paymentHash && invoicePaymentHash === invoice.paymentHash;
  if (allMatch) {
    console.log('PASS: preimage → sha256 → paymentHash chain is intact.');
    console.log('The server controls the preimage, the invoice pays to its hash.');
    console.log('L402 flow is viable with @arkade-os/boltz-swap.');
  } else {
    console.log('FAIL: hash mismatch detected. Investigate before proceeding.');
  }

  await lightning.dispose();
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
