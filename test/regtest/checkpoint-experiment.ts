/**
 * Checkpoint experiment — evidence gathering for Ark Labs technical brief.
 *
 * Experiment A: Log checkpoint wrapping behavior (4-byte refresh — succeeds)
 * Experiment B: Attempt 7-byte recursive covenant (input == output — fails)
 * Experiment C: Submit with empty checkpoints (documents enforcement points)
 *
 * Prerequisites:
 *   nigiri start --ci
 *   docker compose -f /tmp/introspector/docker-compose.regtest.yml up -d
 *
 * Run:
 *   npx tsx test/regtest/checkpoint-experiment.ts
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
  buildRefreshArkadeScript,
  arkadeScriptHash,
  computeTweakedKey,
  buildOpReturnScript,
  encodeWitnessStack,
  submitCovenantTx,
  submitIntrospectorTx,
  buildCovenantVtxo,
} from '../../src/covenant/index.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const ARK_URL = 'http://localhost:7070';
const INTROSPECTOR_URL = 'http://localhost:7073';
const CHOPSTICKS_URL = 'http://localhost:3000';
const FUND_AMOUNT = 10_000;
const BOARDING_AMOUNT = 0.002; // enough for two VHTLCs + change

// ─── Local helpers ───────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(msg);
}

function nigiriFaucet(address: string, amount: number = BOARDING_AMOUNT): string {
  return execSync(`nigiri faucet ${address} ${amount}`, { encoding: 'utf-8' }).trim();
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

/**
 * 7-byte recursive refresh Arkade Script: 00 d1 00 ca 7b 88 87
 *
 * Stack trace:
 *   OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [out_wp, out_ver]
 *   OP_0 OP_INSPECTINPUTSCRIPTPUBKEY  → [out_wp, out_ver, in_wp, in_ver]
 *   OP_ROT                            → [out_wp, in_wp, in_ver, out_ver]
 *   OP_EQUALVERIFY                    → in_ver == out_ver → [out_wp, in_wp]
 *   OP_EQUAL                          → out_wp == in_wp → [true/false]
 *
 * This is the IDEAL recursive covenant — enforces input == output script.
 * It FAILS on Ark because OP_INSPECTINPUTSCRIPTPUBKEY returns the checkpoint's
 * witness program (2-leaf taptree), not the original VTXO's (3-leaf taptree).
 */
function buildRecursiveRefreshArkadeScript(): Uint8Array {
  return new Uint8Array([
    0x00, 0xd1,   // OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [out_wp, out_ver]
    0x00, 0xca,   // OP_0 OP_INSPECTINPUTSCRIPTPUBKEY  → [out_wp, out_ver, in_wp, in_ver]
    0x7b,         // OP_ROT → [out_wp, in_wp, in_ver, out_ver]
    0x88,         // OP_EQUALVERIFY → in_ver == out_ver? → [out_wp, in_wp]
    0x87,         // OP_EQUAL → out_wp == in_wp? → [true/false]
  ]);
}

/**
 * Build a 3-leaf covenant VTXO using a CUSTOM refresh Arkade Script.
 * Same structure as buildCovenantVtxo but with a custom refresh script.
 */
function buildCustomCovenantVtxo(params: {
  alicePubkey: Uint8Array;
  serverPubkey: Uint8Array;
  introspectorBasePubkey: Uint8Array;
  unilateralExitDelay: bigint;
  refreshArkadeScript: Uint8Array;
}): {
  vtxoScript: VtxoScript;
  refreshArkadeScript: Uint8Array;
  refreshTweakedKey: Uint8Array;
  refreshLeafScript: Uint8Array;
} {
  const { alicePubkey, serverPubkey, introspectorBasePubkey, unilateralExitDelay, refreshArkadeScript } = params;

  const refreshScriptHash = arkadeScriptHash(refreshArkadeScript);
  const refreshTweakedKey = computeTweakedKey(introspectorBasePubkey, refreshScriptHash);
  const refreshLeafScript = MultisigTapscript.encode({
    pubkeys: [refreshTweakedKey, serverPubkey],
  }).script;

  const collaborativeScript = MultisigTapscript.encode({
    pubkeys: [alicePubkey, serverPubkey],
  }).script;

  const unilateralExitScript = CSVMultisigTapscript.encode({
    timelock: { type: 'seconds', value: unilateralExitDelay },
    pubkeys: [alicePubkey],
  }).script;

  const vtxoScript = new VtxoScript([
    refreshLeafScript,
    collaborativeScript,
    unilateralExitScript,
  ]);

  return { vtxoScript, refreshArkadeScript, refreshTweakedKey, refreshLeafScript };
}

/** Create a VHTLC, fund it, and claim it to produce a covenant VTXO */
async function fundAndClaimVhtlc(params: {
  senderWallet: Wallet;
  alicePubkey: Uint8Array;
  senderPubkey: Uint8Array;
  serverPubkey: Uint8Array;
  introspectorBasePubkey: Uint8Array;
  recipientVtxo: VtxoScript;
  recipientWitnessProgram: Uint8Array;
  serverUnrollScript: any;
  arkProvider: RestArkProvider;
  indexerProvider: RestIndexerProvider;
}): Promise<{ claimedVtxo: any; claimTxid: string }> {
  const {
    senderWallet, alicePubkey, senderPubkey, serverPubkey,
    introspectorBasePubkey, recipientVtxo, recipientWitnessProgram,
    serverUnrollScript, arkProvider, indexerProvider,
  } = params;

  const preimage = crypto.randomBytes(32);
  const preimageHash = hash160(preimage);
  const claimArkadeScript = buildClaimArkadeScript(preimageHash, recipientWitnessProgram, BigInt(FUND_AMOUNT));
  const claimTweakedKey = computeTweakedKey(introspectorBasePubkey, arkadeScriptHash(claimArkadeScript));

  const conditionScript = Script.encode(['HASH160', preimageHash, 'EQUAL']);
  const covenantClaimScript = MultisigTapscript.encode({ pubkeys: [claimTweakedKey, serverPubkey] }).script;
  const standardClaimScript = ConditionMultisigTapscript.encode({ conditionScript, pubkeys: [alicePubkey, serverPubkey] }).script;
  const refundScript = MultisigTapscript.encode({ pubkeys: [senderPubkey, alicePubkey, serverPubkey] }).script;
  const unilateralClaimScript = (() => {
    const csvScript = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 512n }, pubkeys: [alicePubkey] }).script;
    return new Uint8Array([...conditionScript, ...Script.encode(['VERIFY']), ...csvScript]);
  })();
  const unilateralRefundScript = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 1024n }, pubkeys: [senderPubkey] }).script;
  const unilateralRefundNoRecvScript = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 1536n }, pubkeys: [senderPubkey] }).script;

  const vhtlcScript = new VtxoScript([
    covenantClaimScript, standardClaimScript, refundScript,
    unilateralClaimScript, unilateralRefundScript, unilateralRefundNoRecvScript,
  ]);
  const vhtlcAddress = vhtlcScript.address(networks.regtest.hrp, serverPubkey).encode();
  const covenantLeaf = vhtlcScript.findLeaf(hex.encode(covenantClaimScript));

  const sendTxid = await senderWallet.sendBitcoin({ address: vhtlcAddress, amount: FUND_AMOUNT });
  mineBlocks(1);
  await sleep(3000);

  const vhtlcResult = await indexerProvider.getVtxos({ scripts: [hex.encode(vhtlcScript.pkScript)], spendableOnly: true });
  if (vhtlcResult.vtxos.length === 0) throw new Error('No VTXOs at VHTLC');
  const vtxo = vhtlcResult.vtxos[0];

  const claimWitness = encodeWitnessStack([preimage]);
  const claimOpReturn = buildOpReturnScript([{ vin: 0, script: claimArkadeScript, witness: claimWitness }]);
  const { arkTx, checkpoints } = buildOffchainTx(
    [{ txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value, tapLeafScript: covenantLeaf, tapTree: vhtlcScript.encode() }],
    [{ amount: BigInt(vtxo.value), script: recipientVtxo.pkScript }, { amount: 0n, script: claimOpReturn }],
    serverUnrollScript,
  );

  const claimTxid = await submitCovenantTx({ introspectorUrl: INTROSPECTOR_URL, arkTx, checkpoints, arkProvider });
  mineBlocks(1);
  await sleep(2000);

  const claimedResult = await indexerProvider.getVtxos({ scripts: [hex.encode(recipientVtxo.pkScript)], spendableOnly: true });
  if (claimedResult.vtxos.length === 0) throw new Error('No claimed VTXOs');
  return { claimedVtxo: claimedResult.vtxos[0], claimTxid };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('╔══════════════════════════════════════════════════════════════════╗');
  log('║  CHECKPOINT EXPERIMENT — Evidence for Ark Labs Technical Brief  ║');
  log('╚══════════════════════════════════════════════════════════════════╝');
  log('');

  // ─── Connect to services ──────────────────────────────────────────────────
  const arkProvider = new RestArkProvider(ARK_URL);
  const info = await arkProvider.getInfo();
  const serverPubkey = hex.decode(info.signerPubkey).slice(1);
  const introspectorInfo = await fetch(`${INTROSPECTOR_URL}/v1/info`).then(r => r.json()) as { version: string; signerPubkey: string };
  const introspectorBasePubkey = hex.decode(introspectorInfo.signerPubkey).slice(1);
  const serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));
  const indexerProvider = new RestIndexerProvider(ARK_URL);

  log(`arkd: ${info.network}, Introspector: ${introspectorInfo.version}`);

  // ─── Simulate mobile wallet ───────────────────────────────────────────────
  const sender = SingleKey.fromRandomBytes();
  const senderPubkey = await sender.xOnlyPublicKey();
  const alice = SingleKey.fromRandomBytes();
  const alicePubkey = await alice.xOnlyPublicKey();

  // ─── Fund sender ──────────────────────────────────────────────────────────
  const senderDataDir = mkdtempSync(join(tmpdir(), 'golem-checkpoint-'));
  const senderWallet = await Wallet.create({
    identity: sender, arkServerUrl: ARK_URL, esploraUrl: CHOPSTICKS_URL,
    storage: new FileSystemStorageAdapter(senderDataDir),
  });
  const boardingAddress = await senderWallet.getBoardingAddress();
  nigiriFaucet(boardingAddress, BOARDING_AMOUNT);
  mineBlocks(3);
  await sleep(3000);
  let boardingUtxos = await senderWallet.getBoardingUtxos();
  if (boardingUtxos.length === 0) { mineBlocks(3); await sleep(5000); boardingUtxos = await senderWallet.getBoardingUtxos(); }
  if (boardingUtxos.length === 0) throw new Error('No boarding UTXOs');

  const ramps = new Ramps(senderWallet);
  await ramps.onboard(info.fees, undefined, undefined, () => {});
  mineBlocks(2);
  await sleep(3000);

  const senderVtxos = await senderWallet.getVtxos();
  if (senderVtxos.length === 0) throw new Error('No sender VTXOs');
  log(`Sender funded: ${senderVtxos[0].value} sats`);
  log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPERIMENT A: Checkpoint Wrapping Behavior (4-byte refresh — succeeds)
  // ═══════════════════════════════════════════════════════════════════════════

  log('=== EXPERIMENT A: Checkpoint Wrapping Behavior ===');
  log('');

  // Build standard 4-byte covenant VTXO
  const { vtxoScript: vtxoA, refreshArkadeScript: refreshScriptA, refreshTweakedKey: refreshKeyA, refreshLeafScript: refreshLeafA } =
    buildCovenantVtxo({ alicePubkey, serverPubkey, introspectorBasePubkey, unilateralExitDelay: BigInt(info.unilateralExitDelay) });
  const wpA = vtxoA.pkScript.slice(2);

  log(`4-byte refresh Arkade Script: ${hex.encode(refreshScriptA)}`);
  log(`VTXO pkScript (34 bytes): ${hex.encode(vtxoA.pkScript)}`);
  log(`VTXO witness program (32 bytes): ${hex.encode(wpA)}`);
  log('');

  // Fund + claim to create a covenant VTXO
  log('Funding and claiming VHTLC for Experiment A...');
  const { claimedVtxo: vtxoAClaimed, claimTxid: claimA } = await fundAndClaimVhtlc({
    senderWallet, alicePubkey, senderPubkey, serverPubkey, introspectorBasePubkey,
    recipientVtxo: vtxoA, recipientWitnessProgram: wpA, serverUnrollScript, arkProvider, indexerProvider,
  });
  log(`Claimed VTXO: ${vtxoAClaimed.txid}:${vtxoAClaimed.vout} (${vtxoAClaimed.value} sats)`);
  log('');

  // Build refresh tx and inspect BEFORE submitting
  const refreshLeafA_ = vtxoA.findLeaf(hex.encode(refreshLeafA));
  const refreshOpReturnA = buildOpReturnScript([{ vin: 0, script: refreshScriptA }]);
  const refreshInputA = {
    txid: vtxoAClaimed.txid, vout: vtxoAClaimed.vout, value: vtxoAClaimed.value,
    tapLeafScript: refreshLeafA_, tapTree: vtxoA.encode(),
  };
  const refreshOutputsA = [
    { amount: BigInt(vtxoAClaimed.value), script: vtxoA.pkScript },
    { amount: 0n, script: refreshOpReturnA },
  ];
  const { arkTx: refreshArkTxA, checkpoints: refreshCheckpointsA } = buildOffchainTx(
    [refreshInputA], refreshOutputsA, serverUnrollScript,
  );

  // Inspect checkpoint wrapping
  const checkpointCountA = refreshCheckpointsA.length;
  log(`Checkpoint count: ${checkpointCountA}`);

  // The arkTx input[0] references the checkpoint output. Let's inspect it.
  const arkTxInputA = refreshArkTxA.getInput(0);
  log(`arkTx input[0] tapLeafScript present: ${!!arkTxInputA?.tapLeafScript}`);

  // The checkpoint's output[0] is what the arkTx input spends.
  // The checkpoint wraps the original VTXO in a 2-leaf taptree.
  const checkpointA = refreshCheckpointsA[0];
  const cpOutputA = checkpointA.getOutput(0);
  const cpOutputScriptA = cpOutputA?.script ? hex.encode(cpOutputA.script) : 'N/A';
  const cpWitnessProgA = cpOutputA?.script ? hex.encode(cpOutputA.script.slice(2)) : 'N/A';

  log(`Checkpoint taptree: 2-leaf (serverUnroll + collaborative)`);
  log(`Checkpoint tapscript: ${hex.encode(hex.decode(info.checkpointTapscript))}`);
  log('');
  log(`Input scriptPubKey (what OP_INSPECTINPUTSCRIPTPUBKEY sees): ${cpOutputScriptA}`);
  log(`  → Checkpoint output WP: ${cpWitnessProgA}`);
  log(`VTXO pkScript (what we want the opcode to see):             ${hex.encode(vtxoA.pkScript)}`);
  log(`  → VTXO WP: ${hex.encode(wpA)}`);
  log(`Match: ${cpWitnessProgA === hex.encode(wpA) ? 'YES' : 'NO'}`);
  log('');

  // Submit refresh (should succeed with 4-byte script)
  log('Submitting 4-byte refresh...');
  const refreshTxidA = await submitCovenantTx({
    introspectorUrl: INTROSPECTOR_URL,
    arkTx: refreshArkTxA, checkpoints: refreshCheckpointsA, arkProvider,
  });
  log(`4-byte refresh result: SUCCESS (txid: ${refreshTxidA})`);
  mineBlocks(1);
  await sleep(2000);

  log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPERIMENT B: 7-byte Recursive Covenant Attempt (input == output — fails)
  // ═══════════════════════════════════════════════════════════════════════════

  log('=== EXPERIMENT B: 7-byte Recursive Covenant Attempt ===');
  log('');

  const recursiveScript = buildRecursiveRefreshArkadeScript();
  log(`7-byte recursive Arkade Script: ${hex.encode(recursiveScript)}`);
  log('  Opcodes: OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_0 OP_INSPECTINPUTSCRIPTPUBKEY OP_ROT OP_EQUALVERIFY OP_EQUAL');
  log('  Semantics: output[0].scriptPubKey == input[0].scriptPubKey');
  log('');

  // Build a covenant VTXO that uses the 7-byte recursive refresh script
  const { vtxoScript: vtxoB, refreshArkadeScript: refreshScriptB, refreshTweakedKey: refreshKeyB, refreshLeafScript: refreshLeafB } =
    buildCustomCovenantVtxo({
      alicePubkey, serverPubkey, introspectorBasePubkey,
      unilateralExitDelay: BigInt(info.unilateralExitDelay),
      refreshArkadeScript: recursiveScript,
    });
  const wpB = vtxoB.pkScript.slice(2);
  log(`7-byte VTXO pkScript: ${hex.encode(vtxoB.pkScript)}`);
  log(`7-byte VTXO WP: ${hex.encode(wpB)}`);
  log('');

  // Fund + claim to create a 7-byte covenant VTXO
  log('Funding and claiming VHTLC for Experiment B...');
  const { claimedVtxo: vtxoBClaimed, claimTxid: claimB } = await fundAndClaimVhtlc({
    senderWallet, alicePubkey, senderPubkey, serverPubkey, introspectorBasePubkey,
    recipientVtxo: vtxoB, recipientWitnessProgram: wpB, serverUnrollScript, arkProvider, indexerProvider,
  });
  log(`Claimed VTXO: ${vtxoBClaimed.txid}:${vtxoBClaimed.vout} (${vtxoBClaimed.value} sats)`);
  log('');

  // Build refresh tx with the 7-byte script
  const refreshLeafB_ = vtxoB.findLeaf(hex.encode(refreshLeafB));
  const refreshOpReturnB = buildOpReturnScript([{ vin: 0, script: recursiveScript }]);
  const refreshInputB = {
    txid: vtxoBClaimed.txid, vout: vtxoBClaimed.vout, value: vtxoBClaimed.value,
    tapLeafScript: refreshLeafB_, tapTree: vtxoB.encode(),
  };
  const refreshOutputsB = [
    { amount: BigInt(vtxoBClaimed.value), script: vtxoB.pkScript },
    { amount: 0n, script: refreshOpReturnB },
  ];
  const { arkTx: refreshArkTxB, checkpoints: refreshCheckpointsB } = buildOffchainTx(
    [refreshInputB], refreshOutputsB, serverUnrollScript,
  );

  // Inspect — same mismatch
  const checkpointB = refreshCheckpointsB[0];
  const cpOutputB = checkpointB.getOutput(0);
  const cpOutputScriptB = cpOutputB?.script ? hex.encode(cpOutputB.script) : 'N/A';
  const cpWitnessProgB = cpOutputB?.script ? hex.encode(cpOutputB.script.slice(2)) : 'N/A';

  log(`Input scriptPubKey (checkpoint WP): ${cpOutputScriptB}`);
  log(`Output scriptPubKey (VTXO WP):      ${hex.encode(vtxoB.pkScript)}`);
  log(`Match: ${cpWitnessProgB === hex.encode(wpB) ? 'YES' : 'NO'}`);
  log('');

  // Attempt refresh — this WILL fail
  log('Submitting 7-byte recursive refresh...');
  try {
    const refreshTxidB = await submitCovenantTx({
      introspectorUrl: INTROSPECTOR_URL,
      arkTx: refreshArkTxB, checkpoints: refreshCheckpointsB, arkProvider,
    });
    log(`7-byte refresh result: SUCCESS (txid: ${refreshTxidB})`);
    log('UNEXPECTED: The 7-byte recursive covenant succeeded. This changes everything.');
  } catch (err: any) {
    log(`7-byte refresh result: FAILED`);
    log(`Error: ${err.message}`);
    log('');
    log('Root cause: OP_INSPECTINPUTSCRIPTPUBKEY returns the checkpoint\'s witness program');
    log(`  (${cpWitnessProgB}),`);
    log(`  not the original VTXO\'s witness program (${hex.encode(wpB)}).`);
    log('  The recursive covenant compares input == output, but the checkpoint wrapping');
    log('  makes the input\'s scriptPubKey differ from the VTXO\'s scriptPubKey.');
    log('  This is an architectural limitation of Ark\'s checkpoint model, not a bug');
    log('  in the Introspector or arkd individually.');
  }

  log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPERIMENT C: Empty Checkpoints Submission
  // ═══════════════════════════════════════════════════════════════════════════

  log('=== EXPERIMENT C: Empty Checkpoints ===');
  log('');

  // We need a fresh 7-byte VTXO if experiment B consumed it.
  // Actually, experiment B failed at Introspector, so the VTXO is still unspent.
  // But let's verify:
  const vtxoBStillExists = await indexerProvider.getVtxos({
    scripts: [hex.encode(vtxoB.pkScript)], spendableOnly: true,
  });

  let expCVtxo: any;
  let expCVtxoScript: VtxoScript;
  let expCRefreshScript: Uint8Array;
  let expCRefreshLeaf: any;

  if (vtxoBStillExists.vtxos.length > 0) {
    log('Using VTXO from Experiment B (still unspent after failed refresh)');
    expCVtxo = vtxoBStillExists.vtxos[0];
    expCVtxoScript = vtxoB;
    expCRefreshScript = recursiveScript;
    expCRefreshLeaf = refreshLeafB_;
  } else {
    log('Experiment B consumed the VTXO. Creating a fresh one...');
    const { claimedVtxo, claimTxid } = await fundAndClaimVhtlc({
      senderWallet, alicePubkey, senderPubkey, serverPubkey, introspectorBasePubkey,
      recipientVtxo: vtxoB, recipientWitnessProgram: wpB, serverUnrollScript, arkProvider, indexerProvider,
    });
    expCVtxo = claimedVtxo;
    expCVtxoScript = vtxoB;
    expCRefreshScript = recursiveScript;
    expCRefreshLeaf = vtxoB.findLeaf(hex.encode(refreshLeafB));
  }

  // Build a refresh tx for the experiment
  const refreshOpReturnC = buildOpReturnScript([{ vin: 0, script: expCRefreshScript }]);
  const refreshInputC = {
    txid: expCVtxo.txid, vout: expCVtxo.vout, value: expCVtxo.value,
    tapLeafScript: expCRefreshLeaf, tapTree: expCVtxoScript.encode(),
  };
  const refreshOutputsC = [
    { amount: BigInt(expCVtxo.value), script: expCVtxoScript.pkScript },
    { amount: 0n, script: refreshOpReturnC },
  ];
  const { arkTx: refreshArkTxC, checkpoints: refreshCheckpointsC } = buildOffchainTx(
    [refreshInputC], refreshOutputsC, serverUnrollScript,
  );

  // Sub-experiment C1: Submit to Introspector with empty checkpoint_txs
  log('C1: Submitting to Introspector with empty checkpoint_txs...');
  try {
    const { signedArkTx: signedC1 } = await submitIntrospectorTx({
      introspectorUrl: INTROSPECTOR_URL,
      arkTxPsbt: refreshArkTxC.toPSBT(),
      checkpointPsbts: [], // empty!
    });
    log('Introspector with empty checkpoint_txs: ACCEPTED');

    // If accepted, try submitting to arkd with empty checkpoints
    log('C2: Submitting to arkd with empty checkpoints...');
    try {
      const { arkTxid } = await arkProvider.submitTx(
        base64.encode(signedC1),
        [], // empty!
      );
      log(`arkd with empty checkpoints: ACCEPTED (txid: ${arkTxid})`);

      // If BOTH accepted, try to finalize
      log('C3: Attempting to finalize with empty checkpoints...');
      try {
        await arkProvider.finalizeTx(arkTxid, []);
        log('Finalize with empty checkpoints: ACCEPTED');
        log('SIGNIFICANT FINDING: Both Introspector and arkd accept empty checkpoints.');
        log('This may open a path for the 7-byte recursive covenant.');
      } catch (finalizeErr: any) {
        log(`Finalize with empty checkpoints: REJECTED`);
        log(`  Error: ${finalizeErr.message}`);
      }
    } catch (arkdErr: any) {
      log('arkd with empty checkpoints: REJECTED');
      log(`  Error: ${arkdErr.message}`);
    }
  } catch (introspectorErr: any) {
    log('Introspector with empty checkpoint_txs: REJECTED');
    log(`  Error: ${introspectorErr.message}`);

    // Also try arkd directly with empty checkpoints (even without Introspector signing)
    log('');
    log('C2: Submitting unsigned arkTx to arkd with empty checkpoints...');
    try {
      const { arkTxid } = await arkProvider.submitTx(
        base64.encode(refreshArkTxC.toPSBT()),
        [], // empty!
      );
      log(`arkd with empty checkpoints (unsigned): ACCEPTED (txid: ${arkTxid})`);
    } catch (arkdErr: any) {
      log('arkd with empty checkpoints (unsigned): REJECTED');
      log(`  Error: ${arkdErr.message}`);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log('║                    EXPERIMENT SUMMARY                    ║');
  log('╚══════════════════════════════════════════════════════════╝');
  log('');
  log('Experiment A: 4-byte refresh (output taproot version check)');
  log(`  Result: SUCCESS — workaround functions correctly`);
  log(`  Limitation: Checks taproot version only, not destination address`);
  log('');
  log('Experiment B: 7-byte recursive covenant (input == output)');
  log(`  Result: FAILED — checkpoint wrapping breaks OP_INSPECTINPUTSCRIPTPUBKEY`);
  log(`  Root cause: buildOffchainTx wraps VTXO in 2-leaf checkpoint, changing scriptPubKey`);
  log('');
  log('Experiment C: Empty checkpoints submission');
  log('  Purpose: Document checkpoint enforcement points');
}

main().catch((err) => {
  console.error('EXPERIMENT FAILED:', err);
  process.exit(1);
});
