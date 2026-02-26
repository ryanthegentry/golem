/**
 * Q4: What does on-chain safe harbor ejection require?
 *
 * Analysis of the Unroll (unilateral exit) mechanism from SDK type signatures.
 * This is a static analysis — no live test needed.
 */

async function main() {
  console.log('=== Q4: Safe Harbor Ejection Analysis ===\n');

  console.log('UNROLL (UNILATERAL EXIT) ANALYSIS:');
  console.log('Source: @arkade-os/sdk/dist/types/wallet/unroll.d.ts\n');

  console.log('1. Unroll.Session.create() signature:');
  console.log('   static create(');
  console.log('     toUnroll: Outpoint,');
  console.log('     bumper: AnchorBumper,');
  console.log('     explorer: OnchainProvider,');
  console.log('     indexer: IndexerProvider');
  console.log('   ): Promise<Session>');
  console.log('');
  console.log('   Parameters:');
  console.log('   - Outpoint: { txid, vout } — identifies the VTXO to unroll');
  console.log('   - AnchorBumper: fee bumping (needs signing for anchor spend)');
  console.log('   - OnchainProvider: blockchain access (Esplora)');
  console.log('   - IndexerProvider: Ark VTXO indexer');
  console.log('');
  console.log('   NOTE: No Identity/Wallet parameter — session creation is read-only');
  console.log('   The pre-signed transaction tree data comes from the indexer (the ASP stores it)');

  console.log('\n2. Session steps (async iterator):');
  console.log('   - UNROLL: Broadcast a pre-signed transaction (no signing — tx is already signed)');
  console.log('   - WAIT: Wait for transaction confirmation');
  console.log('   - DONE: Unrolling complete, VTXO is on-chain');
  console.log('');
  console.log('   The unroll steps broadcast PRE-SIGNED transactions from the tx tree.');
  console.log('   No new signing needed — these were signed during the round.');

  console.log('\n3. Unroll.completeUnroll() signature:');
  console.log('   function completeUnroll(');
  console.log('     wallet: Wallet,       // ← FULL Wallet, not ReadonlyWallet');
  console.log('     vtxoTxids: string[],');
  console.log('     outputAddress: string  // ← safe harbor address');
  console.log('   ): Promise<string>');
  console.log('');
  console.log('   THIS is where signing is needed — to spend the CSV-locked output');
  console.log('   after the timelock expires. The pre-signed txs get the VTXO on-chain,');
  console.log('   but the final spend to safe harbor requires a new signature.');

  console.log('\n4. AnchorBumper interface:');
  console.log('   OnchainWallet implements AnchorBumper');
  console.log('   OnchainWallet requires Identity (full, with signing) for:');
  console.log('   - Creating anchor-spend transactions for CPFP fee bumping');
  console.log('   - This is needed for 1C1P (1 confirmation, 1 parent) package relay');

  console.log('\n=== RESULTS ===');
  console.log('SAFE HARBOR EJECTION:');
  console.log('- Unilateral exit requires signing? YES (two places):');
  console.log('  1. AnchorBumper needs signing for fee bumping (CPFP)');
  console.log('  2. completeUnroll() needs signing for CSV path spend');
  console.log('- ReadonlyWallet can PREPARE unsigned exit? PARTIALLY:');
  console.log('  - Session.create() works without signing (reads tx tree from indexer)');
  console.log('  - Broadcasting pre-signed unroll txs needs AnchorBumper (signing)');
  console.log('  - Final CSV spend needs full Wallet');
  console.log('- Minimum data for exit:');
  console.log('  1. Pre-signed transaction tree (stored by ASP, available via indexer)');
  console.log('  2. Private key (for CSV path spend + anchor bumping)');
  console.log('  3. On-chain fees (multiple txs needed)');
  console.log('- Can mobile app sign exit transactions remotely? FEASIBLE');
  console.log('  - Server creates unsigned PSBTs for CSV spend + anchor bump');
  console.log('  - Sends to mobile for signing');
  console.log('  - Server broadcasts signed txs');
  console.log('  - But time-critical: must happen before timelock expires');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
