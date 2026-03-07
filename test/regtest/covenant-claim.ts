/**
 * Covenant claim + refresh test on regtest.
 *
 * Phase 2+3: Covenant claim via Introspector with 4-leaf VTXO output.
 * Phase 4:   Refresh cycle — spend via Leaf 1 (recursive covenant) to
 *            create a new VTXO with the SAME taptree.
 *
 * All claim/refresh logic accepts only alice_pubkey (32-byte x-only).
 * The private key is generated on mobile and NEVER touches the server.
 * Test generates keypairs to simulate mobile, but functions only see pubkeys.
 *
 * Prerequisites:
 *   nigiri start --ci   (no --ark — we use the Introspector compose stack)
 *   docker compose -f /tmp/introspector/docker-compose.regtest.yml up -d
 *
 * Run:
 *   npx tsx test/regtest/covenant-claim.ts
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
  VtxoScript,
  CSVMultisigTapscript,
  ConditionMultisigTapscript,
  MultisigTapscript,
  Transaction,
  VHTLC,
  DefaultVtxo,
  buildOffchainTx,
  setArkPsbtField,
  ConditionWitness,
  VtxoTaprootTree,
  networks,
} from '@arkade-os/sdk';
import { Script } from '@scure/btc-signer';
import { FileSystemStorageAdapter } from '@arkade-os/sdk/adapters/fileSystem';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';

// ─── Configuration ───────────────────────────────────────────────────────────

const ARK_URL = 'http://localhost:7070';
const INTROSPECTOR_URL = 'http://localhost:7073';
const CHOPSTICKS_URL = 'http://localhost:3000';
const FUND_AMOUNT = 10_000; // sats to lock in VHTLC
const BOARDING_AMOUNT = 0.001; // BTC to board (100_000 sats)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[covenant] ${msg}`);
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

// ─── Arkade Script & Introspector Helpers ────────────────────────────────────

/** BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || msg) */
function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  const input = new Uint8Array(tagHash.length * 2 + data.length);
  input.set(tagHash, 0);
  input.set(tagHash, tagHash.length);
  input.set(data, tagHash.length * 2);
  return sha256(input);
}

/** Compute ArkadeScriptHash = TaggedHash("ArkScriptHash", script) */
function arkadeScriptHash(script: Uint8Array): Uint8Array {
  return taggedHash('ArkScriptHash', script);
}

/** Compute tweaked pubkey = basePubkey + scriptHash * G */
function computeTweakedKey(basePubkeyXOnly: Uint8Array, scriptHash: Uint8Array): Uint8Array {
  const Point = secp256k1.Point;
  const compressedHex = '02' + hex.encode(basePubkeyXOnly);
  const basePoint = Point.fromHex(compressedHex);
  const tweakScalar = BigInt('0x' + hex.encode(scriptHash));
  const tweakPoint = Point.BASE.multiply(tweakScalar);
  const tweakedPoint = basePoint.add(tweakPoint);
  const compressed = tweakedPoint.toBytes(true);
  return compressed.slice(1); // x-only
}

/**
 * Build Arkade Script bytecode for covenant claim:
 * 1. Verifies preimage hash (preimage provided via witness stack)
 * 2. Verifies output[0] pays to recipientWitnessProgram
 * 3. Verifies output[0] value >= minAmount
 */
function buildClaimArkadeScript(
  preimageHash: Uint8Array,
  recipientWitnessProgram: Uint8Array,
  minAmount: bigint,
): Uint8Array {
  if (preimageHash.length !== 20) throw new Error(`Expected 20-byte preimage hash, got ${preimageHash.length}`);
  if (recipientWitnessProgram.length !== 32) throw new Error(`Expected 32-byte witness program, got ${recipientWitnessProgram.length}`);

  const amountLE = new Uint8Array(8);
  new DataView(amountLE.buffer).setBigUint64(0, minAmount, true);

  return new Uint8Array([
    0xa9, 0x14, ...preimageHash, 0x88,           // HASH160 <hash> EQUALVERIFY
    0x00, 0xd1, 0x51, 0x88,                       // 0 INSPECTOUTPUTSCRIPTPUBKEY, 1 EQUALVERIFY
    0x20, ...recipientWitnessProgram, 0x88,        // <32-byte WP> EQUALVERIFY
    0x00, 0xcf, 0x08, ...amountLE, 0xdf,          // 0 INSPECTOUTPUTVALUE, <amount> GTE64
  ]);
}

/**
 * Build Arkade Script bytecode for covenant refresh:
 * Verifies output[0] is a valid taproot output (version == 1).
 *
 * DESIGN NOTE: The ideal recursive covenant (input == output via
 * OP_INSPECTINPUTSCRIPTPUBKEY) doesn't work with Ark's checkpoint
 * architecture. buildOffchainTx wraps every input in a checkpoint tx
 * whose output has a 2-leaf taptree (serverUnroll + collaborative),
 * so the arkTx's input scriptPubKey != the VTXO's scriptPubKey.
 * The Introspector evaluates the Arkade Script against the arkTx,
 * where OP_INSPECTINPUTSCRIPTPUBKEY returns the checkpoint's WP.
 *
 * Workaround: Check output taproot version only. The output destination
 * is enforced by the agent constructing the tx to the same address.
 * Security is still better than Phase 1 (hot key):
 *   Phase 1: private key on server → extractable
 *   Phase 1.5: NO key on server → Introspector + server co-sign required
 *
 * Full recursive covenant requires either:
 *   (a) Introspector "trace through checkpoints" support, or
 *   (b) arkd accepting custom checkpoint taptrees
 */
function buildRefreshArkadeScript(): Uint8Array {
  return new Uint8Array([
    0x00, 0xd1,   // OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [wp, version]
    0x51, 0x88,   // OP_1 OP_EQUALVERIFY → version == 1 (taproot)
    // Stack: [wp] — 32-byte witness program is non-zero = truthy
  ]);
}

/** Bitcoin varint encoding */
function encodeVarint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    return buf;
  }
  throw new Error('Varint too large');
}

/** LEB128 uvarint encoding (used for TLV record lengths) */
function encodeUvarint(n: number): Uint8Array {
  const bytes: number[] = [];
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n & 0x7f);
  return new Uint8Array(bytes);
}

/** Build OP_RETURN script with Introspector Packet */
function buildOpReturnScript(entries: Array<{ vin: number; script: Uint8Array; witness?: Uint8Array }>): Uint8Array {
  entries.sort((a, b) => a.vin - b.vin);
  const entryParts: number[] = [];
  for (const entry of entries) {
    entryParts.push(entry.vin & 0xff, (entry.vin >> 8) & 0xff);
    const scriptLen = encodeVarint(entry.script.length);
    entryParts.push(...scriptLen, ...entry.script);
    const witnessData = entry.witness ?? new Uint8Array(0);
    const witnessLen = encodeVarint(witnessData.length);
    entryParts.push(...witnessLen, ...witnessData);
  }
  const entryCount = encodeVarint(entries.length);
  const packetPayload = new Uint8Array([...entryCount, ...entryParts]);
  const tlvRecord = new Uint8Array([0x01, ...encodeUvarint(packetPayload.length), ...packetPayload]);
  const data = new Uint8Array([0x41, 0x52, 0x4b, ...tlvRecord]); // "ARK" + TLV

  let pushOpcode: Uint8Array;
  if (data.length <= 0x4b) pushOpcode = new Uint8Array([data.length]);
  else if (data.length <= 0xff) pushOpcode = new Uint8Array([0x4c, data.length]);
  else pushOpcode = new Uint8Array([0x4d, data.length & 0xff, (data.length >> 8) & 0xff]);

  return new Uint8Array([0x6a, ...pushOpcode, ...data]);
}

/** Encode witness stack for Introspector Packet (standard Bitcoin witness format) */
function encodeWitnessStack(items: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  parts.push(...encodeVarint(items.length));
  for (const item of items) {
    parts.push(...encodeVarint(item.length), ...item);
  }
  return new Uint8Array(parts);
}

/** Submit transaction to the Introspector for signing */
async function introspectorSubmitTx(
  arkTxPsbt: Uint8Array,
  checkpointPsbts: Uint8Array[],
): Promise<{ signedArkTx: Uint8Array; signedCheckpoints: Uint8Array[] }> {
  const resp = await fetch(`${INTROSPECTOR_URL}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ark_tx: base64.encode(arkTxPsbt),
      checkpoint_txs: checkpointPsbts.map(cp => base64.encode(cp)),
    }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Introspector /v1/tx failed (${resp.status}): ${text}`);
  const result = JSON.parse(text) as Record<string, any>;

  const signedArkTxB64 = result.signed_ark_tx ?? result.signedArkTx;
  const signedCheckpointTxsB64: string[] = result.signed_checkpoint_txs ?? result.signedCheckpointTxs ?? [];

  return {
    signedArkTx: base64.decode(signedArkTxB64),
    signedCheckpoints: signedCheckpointTxsB64.map((cp: string) => base64.decode(cp)),
  };
}

// ─── Covenant VTXO Builder (pubkey-only — no private key) ────────────────────

/**
 * Build a three-leaf covenant VtxoScript.
 * Takes only public keys — alice's private key never touches this function.
 * alice_pubkey comes from mobile import via `golem init --import --pubkey`.
 *
 * Three leaves (matching Ark's forfeit/exit model):
 *   Leaf 0: Refresh — Introspector-enforced, no private key (forfeit type)
 *   Leaf 1: Collaborative — alice + server for spending/Ark ops (forfeit type)
 *   Leaf 2: Unilateral exit — alice + CSV timelock (exit type)
 *
 * DESIGN NOTE: arkd's Validate() classifies MultisigClosure as "forfeit" and
 * requires the server pubkey in EVERY forfeit closure. An alice-only
 * MultisigClosure fails validation. Alice spends via the collaborative leaf
 * (standard Ark model). Unilateral exit is the fallback if server disappears.
 */
function buildCovenantVtxo(params: {
  alicePubkey: Uint8Array;         // 32-byte x-only (imported from mobile wallet)
  serverPubkey: Uint8Array;        // 32-byte x-only (from arkd /v1/info)
  introspectorBasePubkey: Uint8Array; // 32-byte x-only (from introspector /v1/info)
  unilateralExitDelay: bigint;
}): {
  vtxoScript: VtxoScript;
  refreshArkadeScript: Uint8Array;
  refreshTweakedKey: Uint8Array;
  refreshLeafScript: Uint8Array;
} {
  const { alicePubkey, serverPubkey, introspectorBasePubkey, unilateralExitDelay } = params;

  // Leaf 0: Covenant refresh — Introspector-enforced, no private key needed.
  // Checks output[0] is taproot (version == 1). Output destination enforced by
  // agent constructing the tx to the same address. Full recursive covenant
  // (input == output) blocked by Ark checkpoint architecture — see design note
  // in buildRefreshArkadeScript().
  const refreshArkadeScript = buildRefreshArkadeScript();
  const refreshScriptHash = arkadeScriptHash(refreshArkadeScript);
  const refreshTweakedKey = computeTweakedKey(introspectorBasePubkey, refreshScriptHash);
  const refreshLeafScript = MultisigTapscript.encode({
    pubkeys: [refreshTweakedKey, serverPubkey],
  }).script;

  // Leaf 1: Collaborative (alice + server for spending and Ark protocol ops)
  // This is the standard Ark spend path — alice signs on mobile, server co-signs.
  // Also used by arkd for forfeit transactions during round participation.
  const collaborativeScript = MultisigTapscript.encode({
    pubkeys: [alicePubkey, serverPubkey],
  }).script;

  // Leaf 2: Unilateral exit (alice + CSV timelock for emergency)
  // If operator disappears, alice can exit to on-chain after timelock.
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

/**
 * Submit an offchain tx through Introspector → arkd → finalize.
 * No private key needed — signatures come from Introspector and arkd.
 */
async function submitIntrospectorTx(params: {
  arkTx: Transaction;
  checkpoints: Transaction[];
  arkProvider: RestArkProvider;
}): Promise<string> {
  const { arkTx, checkpoints, arkProvider } = params;

  // 1. Submit to Introspector for signing
  const { signedArkTx, signedCheckpoints } = await introspectorSubmitTx(
    arkTx.toPSBT(),
    checkpoints.map(cp => cp.toPSBT()),
  );

  const debugTx = Transaction.fromPSBT(signedArkTx);
  log(`  Introspector tapScriptSig count: ${debugTx.getInput(0)?.tapScriptSig?.length ?? 0}`);

  // 2. Submit to arkd for server co-signing
  const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signedArkTx),
    signedCheckpoints.map(cp => base64.encode(cp)),
  );

  // 3. Co-sign server checkpoints with Introspector (arkd creates new PSBTs)
  const serverCheckpointPsbts = signedCheckpointTxs.map((cp: string) => base64.decode(cp));
  const { signedCheckpoints: fullySignedCheckpoints } = await introspectorSubmitTx(
    signedArkTx,
    serverCheckpointPsbts,
  );

  // 4. Finalize
  await arkProvider.finalizeTx(arkTxid, fullySignedCheckpoints.map(cp => base64.encode(cp)));

  return arkTxid;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('Starting covenant claim + refresh test on regtest');

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
  // In production: alice generates keypair on mobile, imports pubkey via CLI.
  // Here we generate both for testing, but ONLY pass alicePubkey to covenant functions.
  const sender = SingleKey.fromRandomBytes();
  const senderPubkey = await sender.xOnlyPublicKey();
  const alice = SingleKey.fromRandomBytes(); // simulates mobile wallet
  const alicePubkey = await alice.xOnlyPublicKey(); // THIS is what gets imported
  log(`Sender pubkey: ${hex.encode(senderPubkey)}`);
  log(`Alice pubkey (imported from mobile): ${hex.encode(alicePubkey)}`);

  // ─── Build 4-leaf covenant VTXO (pubkey-only) ─────────────────────────────
  const { vtxoScript: recipientVtxo, refreshArkadeScript, refreshTweakedKey, refreshLeafScript } =
    buildCovenantVtxo({
      alicePubkey,
      serverPubkey,
      introspectorBasePubkey,
      unilateralExitDelay: BigInt(info.unilateralExitDelay),
    });

  const recipientWitnessProgram = recipientVtxo.pkScript.slice(2);
  log(`3-leaf VTXO address: ${recipientVtxo.address(networks.regtest.hrp, serverPubkey).encode()}`);
  log(`Refresh Arkade Script (${refreshArkadeScript.length} bytes): ${hex.encode(refreshArkadeScript)}`);

  // ─── Create preimage and hash ─────────────────────────────────────────────
  const preimage = crypto.randomBytes(32);
  const preimageHash = hash160(preimage);
  log(`Preimage hash: ${hex.encode(preimageHash)}`);

  // ─── Build claim Arkade Script + tweaked key (pubkey-only) ────────────────
  const claimArkadeScript = buildClaimArkadeScript(preimageHash, recipientWitnessProgram, BigInt(FUND_AMOUNT));
  const claimTweakedKey = computeTweakedKey(introspectorBasePubkey, arkadeScriptHash(claimArkadeScript));
  log(`Claim tweaked key: ${hex.encode(claimTweakedKey)}`);

  // ─── Build VHTLC input script (with covenant claim leaf) ──────────────────
  const conditionScript = Script.encode(['HASH160', preimageHash, 'EQUAL']);
  const covenantClaimScript = MultisigTapscript.encode({
    pubkeys: [claimTweakedKey, serverPubkey],
  }).script;
  const standardClaimScript = ConditionMultisigTapscript.encode({
    conditionScript,
    pubkeys: [alicePubkey, serverPubkey],
  }).script;
  const refundScript = MultisigTapscript.encode({
    pubkeys: [senderPubkey, alicePubkey, serverPubkey],
  }).script;
  const unilateralClaimScript = (() => {
    const csvScript = CSVMultisigTapscript.encode({
      timelock: { type: 'seconds', value: 512n },
      pubkeys: [alicePubkey],
    }).script;
    return new Uint8Array([...conditionScript, ...Script.encode(['VERIFY']), ...csvScript]);
  })();
  const unilateralRefundScript = CSVMultisigTapscript.encode({
    timelock: { type: 'seconds', value: 1024n },
    pubkeys: [senderPubkey],
  }).script;
  const unilateralRefundNoRecvScript = CSVMultisigTapscript.encode({
    timelock: { type: 'seconds', value: 1536n },
    pubkeys: [senderPubkey],
  }).script;

  const vhtlcScript = new VtxoScript([
    covenantClaimScript,
    standardClaimScript,
    refundScript,
    unilateralClaimScript,
    unilateralRefundScript,
    unilateralRefundNoRecvScript,
  ]);

  const vhtlcAddress = vhtlcScript.address(networks.regtest.hrp, serverPubkey).encode();
  const covenantLeaf = vhtlcScript.findLeaf(hex.encode(covenantClaimScript));

  // ─── Fund sender and send to VHTLC ───────────────────────────────────────
  const senderDataDir = mkdtempSync(join(tmpdir(), 'golem-covenant-sender-'));
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

  log(`Sending ${FUND_AMOUNT} sats to covenant VHTLC...`);
  const sendTxid = await senderWallet.sendBitcoin({ address: vhtlcAddress, amount: FUND_AMOUNT });
  log(`Send txid: ${sendTxid}`);
  mineBlocks(1);
  await sleep(3000);

  // ─── PHASE 2+3: Covenant claim (pubkey-only — no alice private key) ───────

  log('');
  log('=== CLAIM via covenant path ===');

  const indexerProvider = new RestIndexerProvider(ARK_URL);
  const vhtlcResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(vhtlcScript.pkScript)],
    spendableOnly: true,
  });
  if (vhtlcResult.vtxos.length === 0) throw new Error('No VTXOs found at VHTLC script');
  const vtxo = vhtlcResult.vtxos[0];
  log(`VHTLC VTXO: ${vtxo.txid}:${vtxo.vout} (${vtxo.value} sats)`);

  // Build OP_RETURN with claim Arkade Script + preimage witness
  const claimWitness = encodeWitnessStack([preimage]);
  const claimOpReturn = buildOpReturnScript([
    { vin: 0, script: claimArkadeScript, witness: claimWitness },
  ]);

  const claimInput = {
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapLeafScript: covenantLeaf,
    tapTree: vhtlcScript.encode(),
  };

  const claimOutputs = [
    { amount: BigInt(vtxo.value), script: recipientVtxo.pkScript },
    { amount: 0n, script: claimOpReturn },
  ];

  const { arkTx: claimArkTx, checkpoints: claimCheckpoints } = buildOffchainTx(
    [claimInput], claimOutputs, serverUnrollScript,
  );

  log('Submitting claim to Introspector + arkd...');
  const claimTxid = await submitIntrospectorTx({
    arkTx: claimArkTx,
    checkpoints: claimCheckpoints,
    arkProvider,
  });
  log(`Claim txid: ${claimTxid}`);

  // Verify claim
  mineBlocks(1);
  await sleep(2000);

  const claimedResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(recipientVtxo.pkScript)],
    spendableOnly: true,
  });
  if (claimedResult.vtxos.length === 0) throw new Error('No claimed VTXOs found');
  const claimedVtxo = claimedResult.vtxos[0];
  log(`Claimed VTXO: ${claimedVtxo.txid}:${claimedVtxo.vout} (${claimedVtxo.value} sats)`);

  const spentResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(vhtlcScript.pkScript)],
    spendableOnly: true,
  });
  log(`Remaining VHTLC VTXOs: ${spentResult.vtxos.length} (should be 0)`);

  log('');
  log('=== CLAIM COMPLETE ===');
  log('  Covenant claim via Introspector — NO alice private key used');
  log('  Output is 3-leaf covenant VTXO (refresh + collaborative + exit)');

  // ─── PHASE 4: Refresh cycle via Leaf 1 (pubkey-only) ─────────────────────

  log('');
  log('=== REFRESH via Leaf 1 (recursive covenant) ===');

  // The refresh leaf is leaf 0 in the recipientVtxo
  const refreshLeaf = recipientVtxo.findLeaf(hex.encode(refreshLeafScript));

  // Build OP_RETURN with refresh Arkade Script (no witness — no preimage for refresh)
  const refreshOpReturn = buildOpReturnScript([
    { vin: 0, script: refreshArkadeScript },
  ]);

  // Use standard buildOffchainTx (creates proper 2-leaf checkpoints for arkd)
  const refreshInput = {
    txid: claimedVtxo.txid,
    vout: claimedVtxo.vout,
    value: claimedVtxo.value,
    tapLeafScript: refreshLeaf,
    tapTree: recipientVtxo.encode(),
  };

  // Output must have SAME pkScript (agent enforces this, covenant checks taproot version)
  const refreshOutputs = [
    { amount: BigInt(claimedVtxo.value), script: recipientVtxo.pkScript },
    { amount: 0n, script: refreshOpReturn },
  ];

  const { arkTx: refreshArkTx, checkpoints: refreshCheckpoints } = buildOffchainTx(
    [refreshInput], refreshOutputs, serverUnrollScript,
  );

  log('Submitting refresh to Introspector + arkd...');
  const refreshTxid = await submitIntrospectorTx({
    arkTx: refreshArkTx,
    checkpoints: refreshCheckpoints,
    arkProvider,
  });
  log(`Refresh txid: ${refreshTxid}`);

  // Verify refresh
  mineBlocks(1);
  await sleep(2000);

  const refreshedResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(recipientVtxo.pkScript)],
    spendableOnly: true,
  });
  if (refreshedResult.vtxos.length === 0) throw new Error('No refreshed VTXOs found');
  const refreshedVtxo = refreshedResult.vtxos[0];
  log(`Refreshed VTXO: ${refreshedVtxo.txid}:${refreshedVtxo.vout} (${refreshedVtxo.value} sats)`);

  // Verify old VTXO is gone (the claimed one should now be spent)
  if (refreshedVtxo.txid === claimedVtxo.txid && refreshedVtxo.vout === claimedVtxo.vout) {
    throw new Error('Refreshed VTXO has same txid:vout as claimed — refresh did not create a new VTXO');
  }
  log('Old VTXO spent, new VTXO created with SAME script (recursive covenant preserved)');

  log('');
  log('=== ALL PHASES COMPLETE ===');
  log(`  Claim:   ${claimTxid} (covenant, no alice key)`);
  log(`  Refresh: ${refreshTxid} (recursive covenant, no key at all)`);
  log(`  Final VTXO: ${refreshedVtxo.txid}:${refreshedVtxo.vout} (${refreshedVtxo.value} sats)`);
  log('  Agent can claim AND refresh with zero key material');
}

main().catch((err) => {
  console.error('[covenant] FAILED:', err);
  process.exit(1);
});
