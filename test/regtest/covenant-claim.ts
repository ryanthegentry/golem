/**
 * Phase 2+3: Covenant claim via Introspector on regtest with 4-leaf VTXO output.
 *
 * Creates a custom VHTLC with a covenant claim leaf that uses the Introspector's
 * tweaked key instead of a receiver key. Claims using only the preimage +
 * Introspector signature + server signature. No receiver private key needed.
 *
 * The claim output is a four-leaf covenant VTXO:
 *   Leaf 1: Recursive covenant (refresh/consolidation via Introspector)
 *   Leaf 2: Alice's spending key (master key on mobile/hardware)
 *   Leaf 3: Collaborative (alice + operator for Ark protocol)
 *   Leaf 4: Unilateral exit (alice + CSV timelock)
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

  // Parse base key as compressed (prepend 02)
  const compressedHex = '02' + hex.encode(basePubkeyXOnly);
  const basePoint = Point.fromHex(compressedHex);

  // Compute scriptHash * G
  const tweakScalar = BigInt('0x' + hex.encode(scriptHash));
  const tweakPoint = Point.BASE.multiply(tweakScalar);

  // Point addition
  const tweakedPoint = basePoint.add(tweakPoint);

  // Return x-only (32 bytes)
  const compressed = tweakedPoint.toBytes(true); // 33 bytes compressed
  return compressed.slice(1); // drop prefix byte → x-only
}

/**
 * Build Arkade Script bytecode for covenant claim:
 * 1. Verifies preimage hash (preimage provided via witness stack)
 * 2. Verifies output[0] pays to recipientWitnessProgram
 * 3. Verifies output[0] value >= minAmount
 */
function buildArkadeScript(
  preimageHash: Uint8Array,
  recipientWitnessProgram: Uint8Array,
  minAmount: bigint,
): Uint8Array {
  if (preimageHash.length !== 20) {
    throw new Error(`Expected 20-byte preimage hash, got ${preimageHash.length}`);
  }
  if (recipientWitnessProgram.length !== 32) {
    throw new Error(`Expected 32-byte witness program, got ${recipientWitnessProgram.length}`);
  }

  // Encode amount as 8-byte little-endian
  const amountLE = new Uint8Array(8);
  const view = new DataView(amountLE.buffer);
  view.setBigUint64(0, minAmount, true);

  return new Uint8Array([
    // 1. Verify preimage (witness stack has preimage on top)
    0xa9,                              // OP_HASH160
    0x14,                              // Push next 20 bytes
    ...preimageHash,                   // 20-byte HASH160 of preimage
    0x88,                              // OP_EQUALVERIFY
    // 2. Verify output[0] scriptPubKey is taproot and matches recipient
    0x00,                              // OP_0 (push index 0)
    0xd1,                              // OP_INSPECTOUTPUTSCRIPTPUBKEY → [witness_program, version]
    0x51,                              // OP_1 (expected taproot version)
    0x88,                              // OP_EQUALVERIFY (check version == 1)
    0x20,                              // Push next 32 bytes
    ...recipientWitnessProgram,        // 32-byte witness program
    0x88,                              // OP_EQUALVERIFY (check witness program matches)
    // 3. Verify output[0] value >= minAmount
    0x00,                              // OP_0 (push index 0)
    0xcf,                              // OP_INSPECTOUTPUTVALUE → [value_u64]
    0x08,                              // Push next 8 bytes
    ...amountLE,                       // 8-byte LE amount
    0xdf,                              // OP_GREATERTHANOREQUAL64 → [1 or 0]
    // Stack: [1] if valid, [0] if not — script succeeds on truthy top
  ]);
}

/**
 * Build Arkade Script bytecode for recursive covenant refresh:
 * Verifies output[0] scriptPubKey == input[0] scriptPubKey (same taptree).
 * This allows the VTXO to be refreshed (extend expiry) without any key.
 */
function buildRefreshArkadeScript(): Uint8Array {
  return new Uint8Array([
    // Push output[0] scriptPubKey → [wp_out, ver_out]
    0x00,       // OP_0 (output index 0)
    0xd1,       // OP_INSPECTOUTPUTSCRIPTPUBKEY
    // Push input[0] scriptPubKey → [wp_out, ver_out, wp_in, ver_in]
    0x00,       // OP_0 (input index 0)
    0xca,       // OP_INSPECTINPUTSCRIPTPUBKEY
    // Compare versions: ROT puts ver_out on top next to ver_in
    0x7b,       // OP_ROT → [wp_out, wp_in, ver_in, ver_out]
    0x88,       // OP_EQUALVERIFY (ver_in == ver_out) → [wp_out, wp_in]
    // Compare witness programs
    0x87,       // OP_EQUAL → [1 if match, 0 if not]
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

/** Build OP_RETURN script with Introspector Packet */
function buildOpReturnScript(entries: Array<{ vin: number; script: Uint8Array; witness?: Uint8Array }>): Uint8Array {
  // Sort entries by vin
  entries.sort((a, b) => a.vin - b.vin);

  // Encode entries
  const entryParts: number[] = [];
  for (const entry of entries) {
    // vin: u16 LE
    entryParts.push(entry.vin & 0xff, (entry.vin >> 8) & 0xff);
    // script: varint length + bytes
    const scriptLen = encodeVarint(entry.script.length);
    entryParts.push(...scriptLen, ...entry.script);
    // witness: varint length + bytes
    const witnessData = entry.witness ?? new Uint8Array(0);
    const witnessLen = encodeVarint(witnessData.length);
    entryParts.push(...witnessLen, ...witnessData);
  }

  // Packet payload: varint entry count + entries
  const entryCount = encodeVarint(entries.length);
  const packetPayload = new Uint8Array([...entryCount, ...entryParts]);

  // TLV record: type=0x01, uvarint length, payload
  const tlvType = 0x01;
  const payloadLen = encodeUvarint(packetPayload.length);
  const tlvRecord = new Uint8Array([tlvType, ...payloadLen, ...packetPayload]);

  // ARK magic + TLV record
  const magic = new Uint8Array([0x41, 0x52, 0x4b]); // "ARK"
  const data = new Uint8Array([...magic, ...tlvRecord]);

  // OP_RETURN + push opcode
  let pushOpcode: Uint8Array;
  if (data.length <= 0x4b) {
    pushOpcode = new Uint8Array([data.length]);
  } else if (data.length <= 0xff) {
    pushOpcode = new Uint8Array([0x4c, data.length]);
  } else {
    pushOpcode = new Uint8Array([0x4d, data.length & 0xff, (data.length >> 8) & 0xff]);
  }

  return new Uint8Array([0x6a, ...pushOpcode, ...data]);
}

/** Encode witness stack for Introspector Packet (standard Bitcoin witness format) */
function encodeWitnessStack(items: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  // varint item count
  const countBytes = encodeVarint(items.length);
  parts.push(...countBytes);
  // each item: varint length + bytes
  for (const item of items) {
    const lenBytes = encodeVarint(item.length);
    parts.push(...lenBytes, ...item);
  }
  return new Uint8Array(parts);
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

/** Submit transaction to the Introspector for signing */
async function introspectorSubmitTx(
  arkTxPsbt: Uint8Array,
  checkpointPsbts: Uint8Array[],
): Promise<{ signedArkTx: Uint8Array; signedCheckpoints: Uint8Array[] }> {
  const body = {
    ark_tx: base64.encode(arkTxPsbt),
    checkpoint_txs: checkpointPsbts.map(cp => base64.encode(cp)),
  };

  const resp = await fetch(`${INTROSPECTOR_URL}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  log(`Introspector response (${resp.status}): ${text.slice(0, 500)}`);
  if (!resp.ok) {
    throw new Error(`Introspector /v1/tx failed (${resp.status}): ${text}`);
  }
  const result2 = JSON.parse(text);

  const result = result2 as Record<string, any>;
  log(`Introspector response keys: ${Object.keys(result).join(', ')}`);

  // gRPC gateway may use camelCase or snake_case
  const signedArkTxB64 = result.signed_ark_tx ?? result.signedArkTx;
  const signedCheckpointTxsB64: string[] = result.signed_checkpoint_txs ?? result.signedCheckpointTxs ?? [];

  return {
    signedArkTx: base64.decode(signedArkTxB64),
    signedCheckpoints: signedCheckpointTxsB64.map((cp: string) => base64.decode(cp)),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('Starting covenant claim test on regtest');

  // 1. Connect to arkd and Introspector
  const arkProvider = new RestArkProvider(ARK_URL);
  const info = await arkProvider.getInfo();
  log(`Connected to arkd ${info.version} on ${info.network}`);

  const serverPubkey = hex.decode(info.signerPubkey).slice(1); // x-only (32 bytes)
  log(`Server pubkey (x-only): ${hex.encode(serverPubkey)}`);

  // Get Introspector info
  const introspectorInfo = await fetch(`${INTROSPECTOR_URL}/v1/info`).then(r => r.json()) as {
    version: string;
    signerPubkey: string;
  };
  const introspectorBasePubkey = hex.decode(introspectorInfo.signerPubkey).slice(1); // x-only (32 bytes)
  log(`Introspector pubkey (x-only): ${hex.encode(introspectorBasePubkey)}`);

  // 2. Create sender identity (receiver not needed for covenant claim!)
  const sender = SingleKey.fromRandomBytes();
  const senderPubkey = await sender.xOnlyPublicKey();
  log(`Sender pubkey: ${hex.encode(senderPubkey)}`);

  // We still create a receiver identity for the FALLBACK hashlock path
  // but the covenant claim won't use it
  const receiver = SingleKey.fromRandomBytes();
  const receiverPubkey = await receiver.xOnlyPublicKey();
  log(`Receiver pubkey (fallback only): ${hex.encode(receiverPubkey)}`);

  // 3. Create preimage and hash
  const preimage = crypto.randomBytes(32);
  const preimageHash = hash160(preimage);
  log(`Preimage: ${hex.encode(preimage)}`);
  log(`Preimage hash (HASH160): ${hex.encode(preimageHash)}`);

  // 4. Build four-leaf recipient VTXO (covenant-enabled)
  // Leaf 1: Recursive covenant (refresh/consolidation) — Introspector-enforced
  const refreshArkadeScript = buildRefreshArkadeScript();
  log(`Refresh Arkade Script (${refreshArkadeScript.length} bytes): ${hex.encode(refreshArkadeScript)}`);
  const refreshScriptHash = arkadeScriptHash(refreshArkadeScript);
  const refreshTweakedKey = computeTweakedKey(introspectorBasePubkey, refreshScriptHash);
  log(`Refresh tweaked key: ${hex.encode(refreshTweakedKey)}`);

  const refreshLeafScript = MultisigTapscript.encode({
    pubkeys: [refreshTweakedKey, serverPubkey],
  }).script;

  // Leaf 2: Alice's spending key (master key on mobile/hardware)
  const aliceSpendScript = MultisigTapscript.encode({
    pubkeys: [receiverPubkey],
  }).script;

  // Leaf 3: Collaborative (alice + operator for Ark protocol operations)
  const collaborativeScript = MultisigTapscript.encode({
    pubkeys: [receiverPubkey, serverPubkey],
  }).script;

  // Leaf 4: Unilateral exit (alice + CSV timelock for emergency)
  const unilateralExitScript = CSVMultisigTapscript.encode({
    timelock: { type: 'seconds', value: BigInt(info.unilateralExitDelay) },
    pubkeys: [receiverPubkey],
  }).script;

  // Build the 4-leaf recipient VtxoScript
  const recipientVtxo = new VtxoScript([
    refreshLeafScript,       // Leaf 1: Recursive covenant
    aliceSpendScript,        // Leaf 2: Alice's key
    collaborativeScript,     // Leaf 3: Collaborative (alice + operator)
    unilateralExitScript,    // Leaf 4: Unilateral exit
  ]);
  // Extract 32-byte witness program from pkScript (skip 0x5120 prefix)
  const recipientWitnessProgram = recipientVtxo.pkScript.slice(2);
  log(`Recipient 4-leaf VTXO witness program: ${hex.encode(recipientWitnessProgram)}`);
  log(`Recipient 4-leaf VTXO address: ${recipientVtxo.address(networks.regtest.hrp, serverPubkey).encode()}`);

  // 5. Build Arkade Script (includes preimage hash check + output introspection)
  const arkadeScript = buildArkadeScript(preimageHash, recipientWitnessProgram, BigInt(FUND_AMOUNT));
  log(`Arkade Script (${arkadeScript.length} bytes): ${hex.encode(arkadeScript)}`);

  // 6. Compute Introspector tweaked key
  const scriptHash = arkadeScriptHash(arkadeScript);
  log(`Script hash: ${hex.encode(scriptHash)}`);
  const introspectorTweakedKey = computeTweakedKey(introspectorBasePubkey, scriptHash);
  log(`Introspector tweaked key: ${hex.encode(introspectorTweakedKey)}`);

  // 7. Build custom VHTLC with covenant claim leaf
  // Leaf A: Covenant claim — PLAIN multisig [introspector_tweaked_key, server_key]
  //         (preimage + introspection verified by Arkade Script in OP_RETURN)
  // Leaf B: Standard hashlock claim — condition(HASH160) + [receiver_key, server_key]
  // Leaf C: Refund — [sender, receiver, server]
  // Leaf D: Unilateral claim — condition(HASH160) + CSV + [receiver]
  // Leaf E: Unilateral refund — CSV + [sender]
  // Leaf F: Unilateral refund without receiver — CSV + [sender]
  const conditionScript = Script.encode(['HASH160', preimageHash, 'EQUAL']);
  log(`Condition script: ${hex.encode(conditionScript)}`);

  // Covenant claim leaf: PLAIN MultisigTapscript (Introspector parses as MultisigClosure)
  // No condition in the tapscript — preimage validation is in the Arkade Script
  const covenantClaimScript = MultisigTapscript.encode({
    pubkeys: [introspectorTweakedKey, serverPubkey],
  }).script;
  log(`Covenant claim script: ${hex.encode(covenantClaimScript)}`);

  // Standard hashlock claim (fallback)
  const standardClaimScript = ConditionMultisigTapscript.encode({
    conditionScript,
    pubkeys: [receiverPubkey, serverPubkey],
  }).script;

  // Refund (sender+receiver+server multisig, no CLTV — matches VHTLC pattern)
  const refundScript = MultisigTapscript.encode({
    pubkeys: [senderPubkey, receiverPubkey, serverPubkey],
  }).script;

  // Unilateral claim (condition + CSV + receiver only)
  const unilateralClaimScript = (() => {
    const csvScript = CSVMultisigTapscript.encode({
      timelock: { type: 'seconds', value: 512n },
      pubkeys: [receiverPubkey],
    }).script;
    return new Uint8Array([...conditionScript, ...Script.encode(['VERIFY']), ...csvScript]);
  })();

  // Unilateral refund (CSV + sender)
  const unilateralRefundScript = CSVMultisigTapscript.encode({
    timelock: { type: 'seconds', value: 1024n },
    pubkeys: [senderPubkey],
  }).script;

  // Unilateral refund without receiver (CSV + sender)
  const unilateralRefundNoRecvScript = CSVMultisigTapscript.encode({
    timelock: { type: 'seconds', value: 1536n },
    pubkeys: [senderPubkey],
  }).script;

  // Build VtxoScript with all leaves
  const vhtlcScript = new VtxoScript([
    covenantClaimScript,          // Leaf 0: Covenant claim (NEW)
    standardClaimScript,          // Leaf 1: Standard hashlock claim
    refundScript,                 // Leaf 2: Refund
    unilateralClaimScript,        // Leaf 3: Unilateral claim
    unilateralRefundScript,       // Leaf 4: Unilateral refund
    unilateralRefundNoRecvScript, // Leaf 5: Unilateral refund (no receiver)
  ]);

  const vhtlcAddress = vhtlcScript.address(networks.regtest.hrp, serverPubkey).encode();
  log(`Custom VHTLC address: ${vhtlcAddress}`);
  log(`Custom VHTLC pkScript: ${hex.encode(vhtlcScript.pkScript)}`);

  // Find the covenant claim leaf
  const covenantLeaf = vhtlcScript.findLeaf(hex.encode(covenantClaimScript));
  log(`Covenant claim leaf found in taptree`);

  // 8. Create sender wallet and fund it
  const senderDataDir = mkdtempSync(join(tmpdir(), 'golem-covenant-sender-'));
  const senderWallet = await Wallet.create({
    identity: sender,
    arkServerUrl: ARK_URL,
    esploraUrl: CHOPSTICKS_URL,
    storage: new FileSystemStorageAdapter(senderDataDir),
  });

  const boardingAddress = await senderWallet.getBoardingAddress();
  log(`Sender boarding address: ${boardingAddress}`);

  // Fund and board
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

  // 9. Send to custom VHTLC address
  log(`Sending ${FUND_AMOUNT} sats to covenant VHTLC...`);
  const sendTxid = await senderWallet.sendBitcoin({
    address: vhtlcAddress,
    amount: FUND_AMOUNT,
  });
  log(`Send txid: ${sendTxid}`);
  mineBlocks(1);
  await sleep(3000);

  // 10. Query for VHTLC VTXOs
  const indexerProvider = new RestIndexerProvider(ARK_URL);
  const result = await indexerProvider.getVtxos({
    scripts: [hex.encode(vhtlcScript.pkScript)],
    spendableOnly: true,
  });

  if (result.vtxos.length === 0) throw new Error('No VTXOs found at covenant VHTLC script');
  const vtxo = result.vtxos[0];
  log(`VHTLC VTXO: txid=${vtxo.txid}, vout=${vtxo.vout}, value=${vtxo.value}`);

  // 11. Build the offchain claim transaction using covenant path
  log('Building covenant claim transaction...');

  const serverUnrollScript = CSVMultisigTapscript.decode(
    hex.decode(info.checkpointTapscript)
  );

  // Build OP_RETURN with Introspector Packet BEFORE buildOffchainTx
  // so it's included in the tx and checkpoints reference the correct txid
  log('Building Introspector Packet (OP_RETURN)...');
  const witnessData = encodeWitnessStack([preimage]);
  const opReturnScript = buildOpReturnScript([
    { vin: 0, script: arkadeScript, witness: witnessData },
  ]);
  log(`OP_RETURN script (${opReturnScript.length} bytes): ${hex.encode(opReturnScript)}`);

  const input = {
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapLeafScript: covenantLeaf,  // Use the COVENANT claim leaf
    tapTree: vhtlcScript.encode(),
  };

  const outputs = [
    { amount: BigInt(vtxo.value), script: recipientVtxo.pkScript },
    { amount: 0n, script: opReturnScript },  // Introspector Packet
  ];

  const { arkTx, checkpoints } = buildOffchainTx(
    [input],
    outputs,
    serverUnrollScript,
  );

  // 14. Submit to Introspector for signing (NO receiver key needed!)
  log('Submitting to Introspector for signing...');
  const { signedArkTx, signedCheckpoints } = await introspectorSubmitTx(
    arkTx.toPSBT(),
    checkpoints.map(cp => cp.toPSBT()),
  );
  log('Introspector signed the transaction!');

  // Debug: inspect the Introspector-signed PSBT
  const debugTx = Transaction.fromPSBT(signedArkTx);
  const debugInput = debugTx.getInput(0);
  log(`Debug: tapScriptSig count: ${debugInput?.tapScriptSig?.length ?? 0}`);

  // 15. Submit Introspector-signed tx to arkd for server co-signing
  log('Submitting to arkd for server co-signing...');
  const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signedArkTx),
    signedCheckpoints.map(cp => base64.encode(cp)),
  );
  log(`Claim submitted! arkTxid: ${arkTxid}`);

  // 16. Finalize checkpoints
  // arkd creates its own checkpoint PSBTs during submitTx, so the
  // Introspector's signature is lost. We need to co-sign them again.
  log('Co-signing server checkpoints with Introspector...');
  const serverCheckpointPsbts = signedCheckpointTxs.map((cp: string) => base64.decode(cp));
  const { signedCheckpoints: fullySignedCheckpoints } = await introspectorSubmitTx(
    signedArkTx,  // Introspector reads OP_RETURN from ark tx for validation
    serverCheckpointPsbts,
  );

  log('Finalizing checkpoints...');
  await arkProvider.finalizeTx(arkTxid, fullySignedCheckpoints.map(cp => base64.encode(cp)));
  log('Checkpoints finalized!');

  // 17. Verify the claimed VTXO
  mineBlocks(1);
  await sleep(2000);

  const claimedResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(recipientVtxo.pkScript)],
    spendableOnly: true,
  });

  if (claimedResult.vtxos.length === 0) {
    throw new Error('No claimed VTXOs found at recipient script');
  }
  const claimedVtxo = claimedResult.vtxos[0];
  log(`Claimed VTXO: txid=${claimedVtxo.txid}, vout=${claimedVtxo.vout}, value=${claimedVtxo.value}`);

  // Verify original VHTLC is spent
  const spentResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(vhtlcScript.pkScript)],
    spendableOnly: true,
  });
  log(`Remaining VHTLC VTXOs: ${spentResult.vtxos.length} (should be 0)`);

  log('');
  log('=== PHASE 3 COMPLETE ===');
  log('  Covenant claim via Introspector — NO receiver key used!');
  log(`  Claimed VTXO: ${claimedVtxo.txid}:${claimedVtxo.vout} (${claimedVtxo.value} sats)`);
  log('  Output is a 4-leaf covenant VTXO:');
  log('    Leaf 1: Recursive covenant (refresh) — Introspector-enforced');
  log('    Leaf 2: Alice spending key');
  log('    Leaf 3: Collaborative (alice + operator)');
  log('    Leaf 4: Unilateral exit (alice + CSV)');
}

main().catch((err) => {
  console.error('[covenant] FAILED:', err);
  process.exit(1);
});
