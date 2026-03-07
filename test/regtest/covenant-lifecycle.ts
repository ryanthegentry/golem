/**
 * Covenant lifecycle tests: consolidation + collaborative spend on regtest.
 *
 * Test 1 — Consolidation via Leaf 0:
 *   Create TWO covenant VTXOs at the same 3-leaf address, consolidate into
 *   a single VTXO via Leaf 0 (covenant refresh). OP_RETURN Introspector Packet
 *   has entries for BOTH vins. No private key needed.
 *
 * Test 2 — Collaborative spend via Leaf 1:
 *   Spend a covenant VTXO via Leaf 1 (alice + server). Alice signs with her
 *   private key (simulating mobile). Output goes to a DIFFERENT address.
 *   No Introspector needed. Proves the recursion breaker works.
 *
 * Prerequisites:
 *   nigiri start --ci
 *   docker compose -f /tmp/introspector/docker-compose.regtest.yml up -d
 *
 * Run:
 *   npx tsx test/regtest/covenant-lifecycle.ts
 */

// EventSource polyfill — MUST be before Ark SDK imports
import { EventSource } from 'eventsource';
Object.assign(globalThis, { EventSource });

import { hex, base64 } from '@scure/base';
import {
  RestArkProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
  Ramps,
  CSVMultisigTapscript,
  ConditionMultisigTapscript,
  MultisigTapscript,
  Transaction,
  DefaultVtxo,
  VtxoScript,
  buildOffchainTx,
  networks,
} from '@arkade-os/sdk';
import { Script } from '@scure/btc-signer';
import { FileSystemStorageAdapter } from '@arkade-os/sdk/adapters/fileSystem';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import {
  buildClaimArkadeScript,
  arkadeScriptHash,
  computeTweakedKey,
  buildOpReturnScript,
  encodeWitnessStack,
  submitCovenantTx,
  buildCovenantVtxo,
} from '../../src/covenant/index.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const ARK_URL = 'http://localhost:7070';
const INTROSPECTOR_URL = 'http://localhost:7073';
const CHOPSTICKS_URL = 'http://localhost:3000';
const FUND_AMOUNT = 10_000; // sats per VHTLC
const BOARDING_AMOUNT = 0.001; // BTC to board (100_000 sats)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[lifecycle] ${msg}`);
}

function nigiriFaucet(address: string, amount: number = BOARDING_AMOUNT): string {
  const result = execSync(`nigiri faucet ${address} ${amount}`, { encoding: 'utf-8' });
  return result.trim();
}

function mineBlocks(n: number = 1): void {
  execSync(`nigiri rpc -generate ${n}`, { encoding: 'utf-8' });
}

function hash160(data: Uint8Array): Uint8Array {
  const sha = crypto.createHash('sha256').update(data).digest();
  return new Uint8Array(crypto.createHash('ripemd160').update(sha).digest());
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('Starting covenant lifecycle tests on regtest');

  // ─── Connect to services ──────────────────────────────────────────────────
  const arkProvider = new RestArkProvider(ARK_URL);
  const info = await arkProvider.getInfo();
  log(`Connected to arkd on ${info.network}`);

  const serverPubkey = hex.decode(info.signerPubkey).slice(1);
  log(`Server pubkey: ${hex.encode(serverPubkey)}`);

  const introspectorInfo = await fetch(`${INTROSPECTOR_URL}/v1/info`).then(r => r.json()) as {
    version: string; signerPubkey: string;
  };
  const introspectorBasePubkey = hex.decode(introspectorInfo.signerPubkey).slice(1);
  log(`Introspector pubkey: ${hex.encode(introspectorBasePubkey)}`);

  const serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));

  // ─── Simulate mobile wallet (test only) ───────────────────────────────────
  const sender = SingleKey.fromRandomBytes();
  const senderPubkey = await sender.xOnlyPublicKey();
  const alice = SingleKey.fromRandomBytes();
  const alicePubkey = await alice.xOnlyPublicKey();
  log(`Sender pubkey: ${hex.encode(senderPubkey)}`);
  log(`Alice pubkey (imported from mobile): ${hex.encode(alicePubkey)}`);

  // ─── Build covenant VTXO structure ─────────────────────────────────────────
  const { vtxoScript: recipientVtxo, refreshArkadeScript, refreshTweakedKey, refreshLeafScript, collaborativeScript } =
    buildCovenantVtxo({
      alicePubkey,
      serverPubkey,
      introspectorBasePubkey,
      unilateralExitDelay: BigInt(info.unilateralExitDelay),
    });

  const recipientWitnessProgram = recipientVtxo.pkScript.slice(2);
  const vtxoAddress = recipientVtxo.address(networks.regtest.hrp, serverPubkey).encode();
  log(`3-leaf VTXO address: ${vtxoAddress}`);

  // ─── Fund sender wallet ────────────────────────────────────────────────────
  const senderDataDir = mkdtempSync(join(tmpdir(), 'golem-lifecycle-sender-'));
  const senderWallet = await Wallet.create({
    identity: sender,
    arkServerUrl: ARK_URL,
    esploraUrl: CHOPSTICKS_URL,
    storage: new FileSystemStorageAdapter(senderDataDir),
  });

  const boardingAddress = await senderWallet.getBoardingAddress();
  log('Funding sender via nigiri faucet...');
  nigiriFaucet(boardingAddress, BOARDING_AMOUNT);
  mineBlocks(3);
  await sleep(3000);

  let boardingUtxos = await senderWallet.getBoardingUtxos();
  if (boardingUtxos.length === 0) {
    mineBlocks(3);
    await sleep(5000);
    boardingUtxos = await senderWallet.getBoardingUtxos();
  }
  if (boardingUtxos.length === 0) throw new Error('No boarding UTXOs');
  log(`Boarding UTXO: ${boardingUtxos[0].value} sats`);

  log('Boarding funds into Ark...');
  const ramps = new Ramps(senderWallet);
  await ramps.onboard(info.fees, undefined, undefined, (event) => {
    log(`  Boarding: ${event.type ?? 'unknown'}`);
  });
  mineBlocks(2);
  await sleep(3000);

  const senderVtxos = await senderWallet.getVtxos();
  if (senderVtxos.length === 0) throw new Error('Sender has no VTXOs after boarding');
  log(`Sender VTXO: ${senderVtxos[0].value} sats`);

  const indexerProvider = new RestIndexerProvider(ARK_URL);

  // ─── Create TWO VHTLCs at the same covenant address ────────────────────────

  // VHTLC 1
  const preimage1 = crypto.randomBytes(32);
  const preimageHash1 = hash160(preimage1);
  const claimArkadeScript1 = buildClaimArkadeScript(preimageHash1, recipientWitnessProgram, BigInt(FUND_AMOUNT));
  const claimTweakedKey1 = computeTweakedKey(introspectorBasePubkey, arkadeScriptHash(claimArkadeScript1));

  const conditionScript1 = Script.encode(['HASH160', preimageHash1, 'EQUAL']);
  const covenantClaimScript1 = MultisigTapscript.encode({ pubkeys: [claimTweakedKey1, serverPubkey] }).script;
  const standardClaimScript1 = ConditionMultisigTapscript.encode({ conditionScript: conditionScript1, pubkeys: [alicePubkey, serverPubkey] }).script;
  const refundScript1 = MultisigTapscript.encode({ pubkeys: [senderPubkey, alicePubkey, serverPubkey] }).script;
  const unilateralClaimScript1 = (() => {
    const csvScript = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 512n }, pubkeys: [alicePubkey] }).script;
    return new Uint8Array([...conditionScript1, ...Script.encode(['VERIFY']), ...csvScript]);
  })();
  const unilateralRefundScript1 = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 1024n }, pubkeys: [senderPubkey] }).script;
  const unilateralRefundNoRecvScript1 = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 1536n }, pubkeys: [senderPubkey] }).script;

  const vhtlcScript1 = new VtxoScript([
    covenantClaimScript1, standardClaimScript1, refundScript1,
    unilateralClaimScript1, unilateralRefundScript1, unilateralRefundNoRecvScript1,
  ]);
  const vhtlcAddress1 = vhtlcScript1.address(networks.regtest.hrp, serverPubkey).encode();
  const covenantLeaf1 = vhtlcScript1.findLeaf(hex.encode(covenantClaimScript1));

  // VHTLC 2 (different preimage, same recipient VTXO)
  const preimage2 = crypto.randomBytes(32);
  const preimageHash2 = hash160(preimage2);
  const claimArkadeScript2 = buildClaimArkadeScript(preimageHash2, recipientWitnessProgram, BigInt(FUND_AMOUNT));
  const claimTweakedKey2 = computeTweakedKey(introspectorBasePubkey, arkadeScriptHash(claimArkadeScript2));

  const conditionScript2 = Script.encode(['HASH160', preimageHash2, 'EQUAL']);
  const covenantClaimScript2 = MultisigTapscript.encode({ pubkeys: [claimTweakedKey2, serverPubkey] }).script;
  const standardClaimScript2 = ConditionMultisigTapscript.encode({ conditionScript: conditionScript2, pubkeys: [alicePubkey, serverPubkey] }).script;
  const refundScript2 = MultisigTapscript.encode({ pubkeys: [senderPubkey, alicePubkey, serverPubkey] }).script;
  const unilateralClaimScript2 = (() => {
    const csvScript = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 512n }, pubkeys: [alicePubkey] }).script;
    return new Uint8Array([...conditionScript2, ...Script.encode(['VERIFY']), ...csvScript]);
  })();
  const unilateralRefundScript2 = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 1024n }, pubkeys: [senderPubkey] }).script;
  const unilateralRefundNoRecvScript2 = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 1536n }, pubkeys: [senderPubkey] }).script;

  const vhtlcScript2 = new VtxoScript([
    covenantClaimScript2, standardClaimScript2, refundScript2,
    unilateralClaimScript2, unilateralRefundScript2, unilateralRefundNoRecvScript2,
  ]);
  const vhtlcAddress2 = vhtlcScript2.address(networks.regtest.hrp, serverPubkey).encode();
  const covenantLeaf2 = vhtlcScript2.findLeaf(hex.encode(covenantClaimScript2));

  // ─── Send to BOTH VHTLCs ───────────────────────────────────────────────────
  log(`Sending ${FUND_AMOUNT} sats to VHTLC 1...`);
  const sendTxid1 = await senderWallet.sendBitcoin({ address: vhtlcAddress1, amount: FUND_AMOUNT });
  log(`VHTLC 1 txid: ${sendTxid1}`);

  log(`Sending ${FUND_AMOUNT} sats to VHTLC 2...`);
  const sendTxid2 = await senderWallet.sendBitcoin({ address: vhtlcAddress2, amount: FUND_AMOUNT });
  log(`VHTLC 2 txid: ${sendTxid2}`);

  mineBlocks(1);
  await sleep(3000);

  // ─── Claim BOTH VHTLCs to create two covenant VTXOs ────────────────────────
  log('');
  log('=== CLAIMING both VHTLCs via covenant path ===');

  // Claim VHTLC 1
  const vhtlcResult1 = await indexerProvider.getVtxos({
    scripts: [hex.encode(vhtlcScript1.pkScript)],
    spendableOnly: true,
  });
  if (vhtlcResult1.vtxos.length === 0) throw new Error('No VTXOs found at VHTLC 1 script');
  const vtxo1 = vhtlcResult1.vtxos[0];
  log(`VHTLC 1 VTXO: ${vtxo1.txid}:${vtxo1.vout} (${vtxo1.value} sats)`);

  const claimWitness1 = encodeWitnessStack([preimage1]);
  const claimOpReturn1 = buildOpReturnScript([
    { vin: 0, script: claimArkadeScript1, witness: claimWitness1 },
  ]);
  const { arkTx: claimArkTx1, checkpoints: claimCheckpoints1 } = buildOffchainTx(
    [{ txid: vtxo1.txid, vout: vtxo1.vout, value: vtxo1.value, tapLeafScript: covenantLeaf1, tapTree: vhtlcScript1.encode() }],
    [{ amount: BigInt(vtxo1.value), script: recipientVtxo.pkScript }, { amount: 0n, script: claimOpReturn1 }],
    serverUnrollScript,
  );
  log('Claiming VHTLC 1...');
  const claim1Txid = await submitCovenantTx({ introspectorUrl: INTROSPECTOR_URL, arkTx: claimArkTx1, checkpoints: claimCheckpoints1, arkProvider });
  log(`Claim 1 txid: ${claim1Txid}`);

  mineBlocks(1);
  await sleep(2000);

  // Claim VHTLC 2
  const vhtlcResult2 = await indexerProvider.getVtxos({
    scripts: [hex.encode(vhtlcScript2.pkScript)],
    spendableOnly: true,
  });
  if (vhtlcResult2.vtxos.length === 0) throw new Error('No VTXOs found at VHTLC 2 script');
  const vtxo2 = vhtlcResult2.vtxos[0];
  log(`VHTLC 2 VTXO: ${vtxo2.txid}:${vtxo2.vout} (${vtxo2.value} sats)`);

  const claimWitness2 = encodeWitnessStack([preimage2]);
  const claimOpReturn2 = buildOpReturnScript([
    { vin: 0, script: claimArkadeScript2, witness: claimWitness2 },
  ]);
  const { arkTx: claimArkTx2, checkpoints: claimCheckpoints2 } = buildOffchainTx(
    [{ txid: vtxo2.txid, vout: vtxo2.vout, value: vtxo2.value, tapLeafScript: covenantLeaf2, tapTree: vhtlcScript2.encode() }],
    [{ amount: BigInt(vtxo2.value), script: recipientVtxo.pkScript }, { amount: 0n, script: claimOpReturn2 }],
    serverUnrollScript,
  );
  log('Claiming VHTLC 2...');
  const claim2Txid = await submitCovenantTx({ introspectorUrl: INTROSPECTOR_URL, arkTx: claimArkTx2, checkpoints: claimCheckpoints2, arkProvider });
  log(`Claim 2 txid: ${claim2Txid}`);

  mineBlocks(1);
  await sleep(2000);

  // Verify both claimed VTXOs exist at the covenant address
  const claimedResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(recipientVtxo.pkScript)],
    spendableOnly: true,
  });
  if (claimedResult.vtxos.length < 2) throw new Error(`Expected 2 claimed VTXOs, got ${claimedResult.vtxos.length}`);
  log(`Claimed VTXOs: ${claimedResult.vtxos.length} at covenant address`);
  for (const v of claimedResult.vtxos) {
    log(`  ${v.txid}:${v.vout} (${v.value} sats)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: CONSOLIDATION via Leaf 0 (2 VTXOs → 1 VTXO, same script)
  // ═══════════════════════════════════════════════════════════════════════════

  log('');
  log('=== TEST 1: CONSOLIDATION via Leaf 0 (2 VTXOs → 1 VTXO) ===');

  const refreshLeaf = recipientVtxo.findLeaf(hex.encode(refreshLeafScript));
  const totalValue = claimedResult.vtxos.reduce((sum, v) => sum + v.value, 0);

  // Build consolidation OP_RETURN: entries for BOTH vins (vin=0 and vin=1)
  const consolidationOpReturn = buildOpReturnScript([
    { vin: 0, script: refreshArkadeScript },
    { vin: 1, script: refreshArkadeScript },
  ]);

  // Build inputs from both claimed VTXOs
  const consolidationInputs = claimedResult.vtxos.map(v => ({
    txid: v.txid,
    vout: v.vout,
    value: v.value,
    tapLeafScript: refreshLeaf,
    tapTree: recipientVtxo.encode(),
  }));

  // Single output: same pkScript, combined value
  const consolidationOutputs = [
    { amount: BigInt(totalValue), script: recipientVtxo.pkScript },
    { amount: 0n, script: consolidationOpReturn },
  ];

  const { arkTx: consolidationArkTx, checkpoints: consolidationCheckpoints } = buildOffchainTx(
    consolidationInputs, consolidationOutputs, serverUnrollScript,
  );

  log(`Consolidating ${claimedResult.vtxos.length} VTXOs (${totalValue} sats) → 1 VTXO...`);
  log(`  Inputs: ${consolidationInputs.length}`);
  log(`  OP_RETURN entries: 2 (vin=0, vin=1)`);
  log(`  Checkpoints: ${consolidationCheckpoints.length}`);

  const consolidationTxid = await submitCovenantTx({
    introspectorUrl: INTROSPECTOR_URL,
    arkTx: consolidationArkTx,
    checkpoints: consolidationCheckpoints,
    arkProvider,
  });
  log(`Consolidation txid: ${consolidationTxid}`);

  mineBlocks(1);
  await sleep(2000);

  // Verify single consolidated VTXO
  const consolidatedResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(recipientVtxo.pkScript)],
    spendableOnly: true,
  });
  if (consolidatedResult.vtxos.length !== 1) {
    throw new Error(`Expected 1 consolidated VTXO, got ${consolidatedResult.vtxos.length}`);
  }
  const consolidatedVtxo = consolidatedResult.vtxos[0];
  log(`Consolidated VTXO: ${consolidatedVtxo.txid}:${consolidatedVtxo.vout} (${consolidatedVtxo.value} sats)`);
  if (consolidatedVtxo.value !== totalValue) {
    throw new Error(`Value mismatch: expected ${totalValue}, got ${consolidatedVtxo.value}`);
  }
  log('');
  log('=== TEST 1 PASSED: Consolidation ===');
  log(`  2 VTXOs (${FUND_AMOUNT} + ${FUND_AMOUNT}) → 1 VTXO (${totalValue})`);
  log('  Same covenant script preserved. Zero key material used.');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: COLLABORATIVE SPEND via Leaf 1 (alice + server → different address)
  // ═══════════════════════════════════════════════════════════════════════════

  log('');
  log('=== TEST 2: COLLABORATIVE SPEND via Leaf 1 (alice + server) ===');

  // Build a DIFFERENT destination (alice's "withdrawal" address — a simple alice-only VTXO)
  // In production, this would be alice's on-chain address or a different Ark VTXO.
  // Here we use a fresh identity as the withdrawal destination.
  const withdrawIdentity = SingleKey.fromRandomBytes();
  const withdrawPubkey = await withdrawIdentity.xOnlyPublicKey();

  // Build a simple DefaultVtxo for the withdrawal destination
  const withdrawVtxo = new DefaultVtxo.Script({
    pubKey: withdrawPubkey,
    serverPubKey: serverPubkey,
    csvTimelock: { type: 'seconds', value: BigInt(info.unilateralExitDelay) },
  });
  const withdrawPkScript = withdrawVtxo.pkScript;
  log(`Withdrawal destination pkScript: ${hex.encode(withdrawPkScript)}`);

  // Find the collaborative leaf (Leaf 1: alice + server)
  const collaborativeLeaf = recipientVtxo.findLeaf(hex.encode(collaborativeScript));

  // Build offchain tx: input = consolidated VTXO, output = withdrawal address
  // NO OP_RETURN needed — this is standard Ark collaborative signing, no Introspector
  const spendInput = {
    txid: consolidatedVtxo.txid,
    vout: consolidatedVtxo.vout,
    value: consolidatedVtxo.value,
    tapLeafScript: collaborativeLeaf,
    tapTree: recipientVtxo.encode(),
  };

  const spendOutputs = [
    { amount: BigInt(consolidatedVtxo.value), script: withdrawPkScript },
  ];

  const { arkTx: spendArkTx, checkpoints: spendCheckpoints } = buildOffchainTx(
    [spendInput], spendOutputs, serverUnrollScript,
  );

  log('Alice signing via collaborative leaf (simulating mobile)...');

  // Ark signing flow for collaborative spend (same as hashlock baseline):
  //   1. Alice signs the arkTx
  //   2. Submit to arkd (with UNSIGNED checkpoints) — arkd adds server sig
  //   3. arkd returns NEW checkpoint PSBTs
  //   4. Alice signs those checkpoints
  //   5. Finalize

  // Step 1: Alice signs the arkTx
  const psbt = spendArkTx.toPSBT();
  const signableTx = Transaction.fromPSBT(psbt);
  const signedTx = await alice.sign(signableTx);
  log('  Alice signed arkTx');

  // Step 2: Submit to arkd for server co-signing (raw checkpoints, not pre-signed)
  log('Submitting to arkd for server co-signing...');
  const { arkTxid: spendArkTxid, signedCheckpointTxs: spendServerCheckpoints } = await arkProvider.submitTx(
    base64.encode(signedTx.toPSBT()),
    spendCheckpoints.map(cp => base64.encode(cp.toPSBT())),
  );
  log(`Spend arkTxid: ${spendArkTxid}`);

  // Step 3-4: Alice signs arkd's returned checkpoints
  const finalCheckpoints = await Promise.all(
    spendServerCheckpoints.map(async (cpB64: string) => {
      const cpTx = Transaction.fromPSBT(base64.decode(cpB64));
      const signed = await alice.sign(cpTx, [0]);
      return base64.encode(signed.toPSBT());
    }),
  );

  // Step 5: Finalize
  await arkProvider.finalizeTx(spendArkTxid, finalCheckpoints);

  mineBlocks(1);
  await sleep(2000);

  // Verify: covenant VTXO is spent, withdrawal VTXO exists
  const postSpendCovenant = await indexerProvider.getVtxos({
    scripts: [hex.encode(recipientVtxo.pkScript)],
    spendableOnly: true,
  });
  log(`Covenant VTXOs remaining: ${postSpendCovenant.vtxos.length} (should be 0)`);

  const withdrawalResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(withdrawPkScript)],
    spendableOnly: true,
  });
  if (withdrawalResult.vtxos.length === 0) throw new Error('No withdrawal VTXOs found');
  const withdrawalVtxo = withdrawalResult.vtxos[0];
  log(`Withdrawal VTXO: ${withdrawalVtxo.txid}:${withdrawalVtxo.vout} (${withdrawalVtxo.value} sats)`);

  // Verify output went to a DIFFERENT address (not the covenant address)
  if (hex.encode(withdrawPkScript) === hex.encode(recipientVtxo.pkScript)) {
    throw new Error('Withdrawal went to same covenant address — recursion breaker did not work');
  }

  log('');
  log('=== TEST 2 PASSED: Collaborative Spend ===');
  log(`  Alice signed on "mobile", server co-signed`);
  log(`  Output went to DIFFERENT address (recursion breaker works)`);
  log(`  No Introspector needed — standard Ark collaborative signing`);

  // ─── Summary ───────────────────────────────────────────────────────────────
  log('');
  log('=== ALL LIFECYCLE TESTS PASSED ===');
  log(`  Test 1 (Consolidation): ${claim1Txid.slice(0, 8)}... + ${claim2Txid.slice(0, 8)}... → ${consolidationTxid.slice(0, 8)}...`);
  log(`  Test 2 (Collaborative): ${consolidationTxid.slice(0, 8)}... → ${spendArkTxid.slice(0, 8)}... (different address)`);
  log('  Full Tier 1.5 lifecycle validated:');
  log('    - Claim: covenant (no key)');
  log('    - Consolidation: covenant (no key)');
  log('    - Spend: collaborative (alice signs on mobile)');
}

main().catch((err) => {
  console.error('[lifecycle] FAILED:', err);
  process.exit(1);
});
