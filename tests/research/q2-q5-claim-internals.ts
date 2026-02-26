/**
 * Q2 + Q5: waitAndClaim() Internals & OOR vs Round-Based Settlement
 *
 * Static analysis of the claim implementation, verified by examining
 * the actual Boltz swap JS source code.
 */

async function main() {
  console.log('=== Q2 + Q5: waitAndClaim() Internals ===\n');

  console.log('SOURCE: @arkade-os/boltz-swap/dist/index.js\n');

  console.log('WAITANDCLAIM FLOW:');
  console.log('');
  console.log('Step 1: Monitor swap status via WebSocket');
  console.log('  → monitorSwap(swapId, callback)');
  console.log('  → WebSocket: wss://api.boltz.mutinynet.arkade.sh/v2/ws');
  console.log('  → Subscribe: {"op":"subscribe","channel":"swap.update","args":[swapId]}');
  console.log('');
  console.log('Step 2: On status "transaction.mempool" or "transaction.confirmed"');
  console.log('  → claimVHTLC(pendingSwap) triggered');
  console.log('');
  console.log('Step 3: claimVHTLC() does:');
  console.log('  a. Get preimage from pendingSwap.preimage (generated at creation)');
  console.log('  b. Get 3 public keys:');
  console.log('     - ours (wallet.identity.xOnlyPublicKey)');
  console.log('     - boltz (pendingSwap.response.refundPublicKey)');
  console.log('     - server/ASP (arkProvider.getInfo().signerPubkey)');
  console.log('  c. Reconstruct VHTLC script from these keys + timeout heights');
  console.log('  d. VERIFY lockup address matches (anti-scam check)');
  console.log('  e. Find VHTLC in Ark indexer:');
  console.log('     indexerProvider.getVtxos({scripts: [vhtlcScript.pkScript]})');
  console.log('     → NOT visible via readonlyWallet.getVtxos() (different script)');
  console.log('  f. Wrap identity with claimVHTLCIdentity (injects preimage into witness)');
  console.log('  g. CHOOSE CLAIM PATH:');
  console.log('');

  console.log('CLAIM PATH DECISION:');
  console.log('  if (isRecoverable(vtxo)) {');
  console.log('    → joinBatch() — IN-ROUND CLAIM');
  console.log('    → Participates in next Ark batch');
  console.log('    → 3 signatures: register intent, delete intent, forfeit');
  console.log('    → MuSig2 tree signing (uses signerSession ephemeral key)');
  console.log('    → VTXO created when round commits');
  console.log('  } else {');
  console.log('    → claimVHTLCwithOffchainTx() — OUT-OF-ROUND CLAIM');
  console.log('    → Direct settlement via buildOffchainTx()');
  console.log('    → Submit to ASP for server cosignature');
  console.log('    → 2 signatures: ark TX + checkpoint TX');
  console.log('  }');
  console.log('');

  console.log('Step 4: On status "invoice.settled"');
  console.log('  → waitAndClaim() resolves with {txid}');
  console.log('  → This is the FINAL state');
  console.log('');

  console.log('VHTLC TAPSCRIPT LEAVES (4 spending paths):');
  console.log('  1. claim(): Receiver + Server + preimage → Normal claim');
  console.log('  2. refund(): Sender (Boltz) + Server → After refund timeout');
  console.log('  3. unilateral refund w/o receiver: Sender only → After long timeout');
  console.log('  4. unilateral claim: Receiver only → After claim timeout');
  console.log('');

  console.log('ARK OPERATIONS CALLED:');
  console.log('  IN-ROUND PATH (joinBatch):');
  console.log('  1. identity.signerSession() → ephemeral MuSig2 key');
  console.log('  2. Intent.create(registerMessage, inputs, outputs)');
  console.log('  3. Intent.create(deleteMessage, inputs)');
  console.log('  4. identity.sign(registerIntent) ← SIGNATURE #1');
  console.log('  5. identity.sign(deleteIntent) ← SIGNATURE #2');
  console.log('  6. arkProvider.registerIntent(signedIntent)');
  console.log('  7. Batch.join(eventStream, handler) → round participation');
  console.log('     → Inside Batch.join:');
  console.log('        - MuSig2 nonce exchange');
  console.log('        - Tree signing (ephemeral key, not master)');
  console.log('        - Forfeit TX signing ← SIGNATURE #3');
  console.log('        - Round finalization');
  console.log('');
  console.log('  OUT-OF-ROUND PATH (claimVHTLCwithOffchainTx):');
  console.log('  1. buildOffchainTx(inputs, outputs, serverUnrollScript)');
  console.log('  2. identity.sign(arkTx) ← SIGNATURE #1 (preimage injected)');
  console.log('  3. arkProvider.submitTx(signedTx, checkpoints)');
  console.log('  4. identity.sign(checkpoint) ← SIGNATURE #2');
  console.log('  5. arkProvider.finalizeTx(txid, signedCheckpoints)');
  console.log('');

  console.log('BOLTZ API CALLS DURING CLAIM:');
  console.log('  - monitorSwap: WebSocket subscription (status updates)');
  console.log('  - getReverseSwapTxId: GET /v2/swap/{id}/transaction (after settlement)');
  console.log('  - NO Boltz-specific claim endpoint — claiming is purely Ark-side');
  console.log('  - Boltz detects claim by watching the Ark commitment/settlement TX');
  console.log('  - Boltz extracts preimage from the Ark TX witness data');
  console.log('  - Boltz then settles the Lightning hold invoice using extracted preimage');
  console.log('');

  console.log('=== Q5: OOR vs ROUND-BASED SETTLEMENT ===');
  console.log('');
  console.log('ANSWER: BOTH, depending on VTXO state:');
  console.log('  - isRecoverable(vtxo) → IN-ROUND (joinBatch → Batch.join)');
  console.log('  - !isRecoverable(vtxo) → OFF-CHAIN TX (claimVHTLCwithOffchainTx)');
  console.log('');
  console.log('The in-round path is the normal/preferred flow.');
  console.log('The off-chain TX path is a fallback for older/orphaned VHTLCs.');
  console.log('Neither path is a standard OOR "sendBitcoin" — both are');
  console.log('specialized VHTLC claim flows with preimage revelation.');
  console.log('');
  console.log('After claiming, the resulting VTXO is a standard Ark VTXO');
  console.log('(no longer a VHTLC). It appears in wallet.getVtxos() and');
  console.log('is subject to normal refresh/expiry lifecycle.');
  console.log('');

  console.log('=== Q2 REPORT ===');
  console.log('WAITANDCLAIM INTERNALS:');
  console.log('- Steps: [see flow above]');
  console.log('- Ark operations: signerSession, Intent.create, identity.sign (x2-3), Batch.join');
  console.log('- Boltz API calls: WebSocket monitor only; no claim endpoint');
  console.log('- Settlement type: in-round (joinBatch) OR off-chain TX, NOT standard OOR');
  console.log('- Can claim be done independently later? YES — see Q4 analysis');
  console.log('  pendingSwap has all data needed; just need a signing wallet');

  process.exit(0);
}

main();
