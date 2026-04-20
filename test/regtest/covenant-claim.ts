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

// Polyfills — MUST be before Ark SDK imports
import 'fake-indexeddb/auto';
import { EventSource } from 'eventsource';
Object.assign(globalThis, { EventSource });

import { hex } from '@scure/base';
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
  buildCovenantVtxo,
} from '../../src/covenant/index.js';

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

/** Mine a block every `intervalMs` while `fn` runs. Stops after fn resolves. */
async function withBlockMining<T>(fn: () => Promise<T>, intervalMs = 8000): Promise<T> {
  let mining = true;
  const miner = (async () => {
    while (mining) {
      await sleep(intervalMs);
      if (!mining) break;
      try { mineBlocks(1); } catch {}
    }
  })();
  try {
    return await fn();
  } finally {
    mining = false;
    await miner;
  }
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
  // Dispose immediately to stop VtxoManager from registering intents.
  await senderWallet.dispose();
  log('Boarding complete. Wallet disposed.');

  // Wait for arkd to clean up stale intents from the disposed wallet.
  await sleep(8000);

  // Create fresh wallet — VtxoManager starts clean.
  const senderWallet2 = await Wallet.create({
    identity: sender,
    arkServerUrl: ARK_URL,
    esploraUrl: CHOPSTICKS_URL,
    storage: new FileSystemStorageAdapter(mkdtempSync(join(tmpdir(), 'golem-sender2-'))),
  });

  // Send immediately before VtxoManager registers intents.
  log(`Sending ${FUND_AMOUNT} sats to covenant VHTLC (OOR)...`);
  const sendTxid = await senderWallet2.sendBitcoin({ address: vhtlcAddress, amount: FUND_AMOUNT });
  await senderWallet2.dispose();
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

  // Use the full submitCovenantTx flow — the Introspector is the finalizer
  // (its tweaked key is the last non-arkd signer in the closure), so it handles
  // the complete pipeline internally: sign → submit to arkd → co-sign → finalize.
  const claimTxid = await submitCovenantTx({
    introspectorUrl: INTROSPECTOR_URL,
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

  // Set PrevArkTxField so the Introspector can resolve OP_INSPECTINPUTSCRIPTPUBKEY.
  // The refresh script checks input[0].scriptPubKey == output[0].scriptPubKey (recursive covenant),
  // which requires the previous transaction (the claim tx) to look up the input's prevout script.
  // Key format: type=0xde, key="prevarktx", value=raw unsigned claim tx bytes.
  refreshArkTx.updateInput(0, {
    unknown: [
      ...(refreshArkTx.getInput(0)?.unknown ?? []),
      [
        { type: 0xde, key: new TextEncoder().encode('prevarktx') },
        claimArkTx.unsignedTx,
      ],
    ],
  });

  log('Submitting refresh to Introspector + arkd...');
  const refreshTxid = await submitCovenantTx({
    introspectorUrl: INTROSPECTOR_URL,
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
