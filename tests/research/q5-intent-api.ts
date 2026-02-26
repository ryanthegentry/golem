/**
 * Q5: Intent.create() type signature analysis
 *
 * Static analysis of the Intent API for future delegation work.
 */

async function main() {
  console.log('=== Q5: Intent API Analysis ===\n');

  console.log('Source: @arkade-os/sdk/dist/types/intent/index.d.ts\n');

  console.log('INTENT NAMESPACE:');
  console.log('');
  console.log('  type Proof = Transaction;');
  console.log('');
  console.log('  function create(');
  console.log('    message: string | Message,');
  console.log('    inputs: TransactionInput[],   // from @scure/btc-signer/psbt');
  console.log('    outputs?: TransactionOutput[]  // from @scure/btc-signer/psbt');
  console.log('  ): Proof;');
  console.log('');
  console.log('  function fee(proof: Proof): number;');
  console.log('');
  console.log('  function encodeMessage(message: Message): string;');
  console.log('');
  console.log('MESSAGE TYPES:');
  console.log('');
  console.log('  RegisterMessage = {');
  console.log('    type: "register";');
  console.log('    onchain_output_indexes: number[];');
  console.log('    valid_at: number;');
  console.log('    expire_at: number;');
  console.log('    cosigners_public_keys: string[];');
  console.log('  }');
  console.log('');
  console.log('  DeleteMessage = {');
  console.log('    type: "delete";');
  console.log('    expire_at: number;');
  console.log('  }');
  console.log('');
  console.log('  GetPendingTxMessage = {');
  console.log('    type: "get-pending-tx";');
  console.log('    expire_at: number;');
  console.log('  }');
  console.log('');
  console.log('  Message = RegisterMessage | DeleteMessage | GetPendingTxMessage;');

  console.log('\n\nGOLEM WALLET SDK ACCESS:');
  console.log('  GolemWallet.sdkWallet — public readonly Wallet property');
  console.log('  Exposed directly: no getter needed');

  console.log('\n=== RESULTS ===');
  console.log('INTENT API:');
  console.log('- Intent.create() signature: create(message: string | Message, inputs: TransactionInput[], outputs?: TransactionOutput[]): Proof');
  console.log('- Parameters:');
  console.log('  1. message — RegisterMessage | DeleteMessage | GetPendingTxMessage | raw string');
  console.log('  2. inputs — TransactionInput[] (VTXO outpoints to prove ownership of)');
  console.log('  3. outputs — optional TransactionOutput[]');
  console.log('- Returns: Transaction (unsigned, needs identity.sign())');
  console.log('- GolemWallet exposes underlying Wallet? YES (readonly sdkWallet property)');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
