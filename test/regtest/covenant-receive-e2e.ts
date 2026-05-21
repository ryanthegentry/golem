/**
 * Covenant receive E2E — Fulmine NonInteractiveClaim VHTLC → Golem self-solver claim
 *                       → covenant refresh (repo-backed) → consolidation → collab-spend.
 *
 * Closes the loop on Phase 1.5: proves a real-RPC sender (Fulmine PR #411) can be
 * paired with Golem's covenant claim handler + claims repo + refresh, end to end.
 *
 * Prerequisites:
 *   test/regtest/setup.sh   (starts nigiri + Introspector stack + Fulmine + bancod;
 *                            bootstraps Fulmine wallet on a fresh tmpfs volume)
 *
 * Run:
 *   npx tsx test/regtest/covenant-receive-e2e.ts
 *
 * Pass criteria printed at the end. Throws on any step failure.
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
  VtxoScript,
  networks,
} from '@arkade-os/sdk';
import { FileSystemStorageAdapter } from '@arkade-os/sdk/adapters/fileSystem';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import {
  buildCovenantVtxo,
  covenantRefresh,
  hash160,
} from '../../src/covenant/index.js';
import {
  buildCovenantClaimLeaf,
} from '../../src/covenant/vhtlc-detection.js';
import { CovenantClaimHandler } from '../../src/covenant/claim-handler.js';
import { CovenantClaimsRepo } from '../../src/storage/covenant-claims-repo.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const ARK_URL = 'http://localhost:7070';
const INTROSPECTOR_URL = 'http://localhost:7073';
const FULMINE_REST = 'http://localhost:7001/api';
const CHOPSTICKS_URL = 'http://localhost:3000';
const FUND_AMOUNT = 10_000;
const BOARDING_AMOUNT = 0.001; // BTC

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`[e2e] ${msg}`); }
function bail(msg: string): never { throw new Error(msg); }
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
const NIGIRI_BIN = process.env.NIGIRI_BIN || `${process.env.HOME}/.local/bin/nigiri`;
function mineBlocks(n: number = 1): void { execSync(`${NIGIRI_BIN} rpc -generate ${n}`, { encoding: 'utf-8' }); }
function nigiriFaucet(address: string, amount: number = BOARDING_AMOUNT): string {
  return execSync(`${NIGIRI_BIN} faucet ${address} ${amount}`, { encoding: 'utf-8' }).trim();
}

async function fulminePost(path: string, body: unknown): Promise<any> {
  const resp = await fetch(`${FULMINE_REST}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) bail(`POST ${path} failed (${resp.status}): ${text}`);
  return JSON.parse(text || '{}');
}

async function fulmineGet(path: string): Promise<any> {
  const resp = await fetch(`${FULMINE_REST}${path}`);
  const text = await resp.text();
  if (!resp.ok) bail(`GET ${path} failed (${resp.status}): ${text}`);
  return JSON.parse(text || '{}');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('Starting covenant receive E2E (Fulmine PR #411 → Golem self-solver)');

  // 1. Connect.
  const arkProvider = new RestArkProvider(ARK_URL);
  const indexerProvider = new RestIndexerProvider(ARK_URL);
  const info = await arkProvider.getInfo();
  log(`arkd network: ${info.network}, unilateralExitDelay: ${info.unilateralExitDelay}`);

  // Compressed → x-only (drop 0x02/0x03 prefix).
  const serverPubkey = hex.decode(info.signerPubkey).slice(1);
  log(`arkd server pubkey: ${hex.encode(serverPubkey)}`);

  const introInfo = await fetch(`${INTROSPECTOR_URL}/v1/info`).then(r => r.json()) as {
    version: string; signerPubkey: string;
  };
  const introspectorBasePubkey = hex.decode(introInfo.signerPubkey).slice(1);
  // Compressed form for Fulmine (33-byte 02/03 prefix) — Fulmine's NonInteractiveClaim
  // expects compressed bytes per the proto comment "33 bytes compressed public key".
  const introspectorCompressed = hex.decode(introInfo.signerPubkey);
  log(`introspector pubkey (x-only): ${hex.encode(introspectorBasePubkey)}`);

  const serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));

  // 2. Golem's receiver covenant address.
  //    alice = simulates mobile wallet (we generate the key for the test; in production
  //    only the pubkey would be on the server).
  const alice = SingleKey.fromRandomBytes();
  const alicePubkey = await alice.xOnlyPublicKey();
  const receiver = buildCovenantVtxo({
    alicePubkey, serverPubkey, introspectorBasePubkey,
    unilateralExitDelay: BigInt(info.unilateralExitDelay),
  });
  const receiverArkAddress = receiver.vtxoScript.address(networks.regtest.hrp, serverPubkey).encode();
  log(`Golem covenant receive address: ${receiverArkAddress}`);

  // 3. CovenantClaimsRepo + Handler.
  const dataDir = mkdtempSync(join(tmpdir(), 'golem-e2e-'));
  const claimsRepo = new CovenantClaimsRepo(join(dataDir, 'claims.db'));
  const handler = new CovenantClaimHandler(claimsRepo);

  try {
    // 4. Sender wallet (Golem-built — funds VHTLCs that Fulmine creates).
    log('Boarding sender into Ark...');
    const sender = SingleKey.fromRandomBytes();
    const senderPubkey = await sender.xOnlyPublicKey();
    log(`  sender pubkey: ${hex.encode(senderPubkey).slice(0, 16)}...`);
    const senderDir = mkdtempSync(join(tmpdir(), 'golem-e2e-sender-'));
    log(`  creating sender wallet...`);
    const senderWallet = await Wallet.create({
      identity: sender,
      arkServerUrl: ARK_URL,
      esploraUrl: CHOPSTICKS_URL,
      storage: new FileSystemStorageAdapter(senderDir),
    });
    log(`  sender wallet created`);
    const boardingAddress = await senderWallet.getBoardingAddress();
    log(`  boarding address: ${boardingAddress}`);
    nigiriFaucet(boardingAddress, BOARDING_AMOUNT);
    log(`  faucet sent ${BOARDING_AMOUNT} BTC`);
    mineBlocks(3);
    await sleep(3000);
    let boardingUtxos = await senderWallet.getBoardingUtxos();
    log(`  boarding UTXOs after first poll: ${boardingUtxos.length}`);
    if (boardingUtxos.length === 0) {
      mineBlocks(3); await sleep(5000);
      boardingUtxos = await senderWallet.getBoardingUtxos();
      log(`  boarding UTXOs after second poll: ${boardingUtxos.length}`);
    }
    if (boardingUtxos.length === 0) bail('sender has no boarding UTXOs');
    log(`  boarding ${boardingUtxos[0].value} sats into Ark...`);
    const ramps = new Ramps(senderWallet);
    await ramps.onboard(info.fees, undefined, undefined, () => {});
    log(`  onboarded; disposing wallet to release intents`);
    await senderWallet.dispose();
    await sleep(8000);
    log(`Sender boarded ${boardingUtxos[0].value} sats.`);

    // Helper: create one Fulmine VHTLC + send funds + run handler + return resulting VTXO.
    async function processOneClaim(label: string): Promise<{ txid: string; vout: number; value: number }> {
      log(`──── ${label} ────`);

      // 5. Preimage on Golem side.
      const preimage = crypto.randomBytes(32);
      const preimageHash = hash160(preimage);
      log(`  preimage_hash: ${hex.encode(preimageHash)}`);

      // 6. Per-VHTLC keys. sender_pubkey = our sender's compressed pubkey; receiver_pubkey
      //    = alice's compressed pubkey (the participant in Golem's collab-spend leaf).
      //    Fulmine accepts compressed (33-byte) pubkeys per the proto.
      const aliceCompressedHex = '02' + hex.encode(alicePubkey);
      const senderCompressedHex = '02' + hex.encode(senderPubkey);

      // 7. CreateVHTLC. Fulmine's API requires XOR(sender_pubkey, receiver_pubkey)
      //    — caller provides the OTHER party's key and Fulmine derives its own.
      //    Here Golem is the receiver (holds preimage + covenant claim leaf), so
      //    Fulmine is the sender; we provide receiver_pubkey only.
      const createResp = await fulminePost('/v1/vhtlc', {
        preimage_hash: hex.encode(preimageHash),
        receiver_pubkey: aliceCompressedHex,
        unilateral_claim_delay: { type: 'LOCKTIME_TYPE_SECOND', value: 512 },
        unilateral_refund_delay: { type: 'LOCKTIME_TYPE_SECOND', value: 512 },
        unilateral_refund_without_receiver_delay: { type: 'LOCKTIME_TYPE_SECOND', value: 1024 },
        non_interactive_claim: {
          claim_receiver_address: receiverArkAddress,
          introspector_pubkey: hex.encode(introspectorCompressed),
        },
      });
      const vhtlcAddress: string = createResp.address;
      const swapTree = createResp.swapTree ?? createResp.swap_tree;
      if (!vhtlcAddress || !swapTree) bail(`CreateVHTLC response missing fields: ${JSON.stringify(createResp).slice(0, 200)}`);
      log(`  Fulmine VHTLC address: ${vhtlcAddress}`);

      // 8. Reconstruct the full 7-leaf VtxoScript from Fulmine's 6-leaf TaprootTree
      //    plus our locally-computed covenant claim leaf. Order matches Fulmine's
      //    pkg/vhtlc/vhtlc.go (claim, refund, refundWithoutReceiver, unilateralClaim,
      //    unilateralRefund, unilateralRefundWithoutReceiver, nonInteractiveClaim).
      const sixLeaves = [
        swapTree.claimLeaf ?? swapTree.claim_leaf,
        swapTree.refundLeaf ?? swapTree.refund_leaf,
        swapTree.refundWithoutBoltzLeaf ?? swapTree.refund_without_boltz_leaf,
        swapTree.unilateralClaimLeaf ?? swapTree.unilateral_claim_leaf,
        swapTree.unilateralRefundLeaf ?? swapTree.unilateral_refund_leaf,
        swapTree.unilateralRefundWithoutBoltzLeaf ?? swapTree.unilateral_refund_without_boltz_leaf,
      ].map((leaf: any) => {
        if (!leaf?.output) bail(`Fulmine returned a leaf without .output`);
        return hex.decode(leaf.output);
      });
      const covenantLeaf = buildCovenantClaimLeaf({
        serverPubKey: serverPubkey,
        introspectorPubKey: introspectorBasePubkey,
        receiverPkScript: receiver.vtxoScript.pkScript,
        preimageHash,
      }).leafScript;
      const allLeaves = [...sixLeaves, covenantLeaf];
      const vhtlcVtxoScript = new VtxoScript(allLeaves);
      const reconstructedAddress = vhtlcVtxoScript.address(networks.regtest.hrp, serverPubkey).encode();
      if (reconstructedAddress !== vhtlcAddress) {
        bail(`Reconstructed VHTLC address ${reconstructedAddress} != Fulmine's ${vhtlcAddress}`);
      }
      log(`  Reconstructed VtxoScript matches Fulmine's address ✓`);

      // 9. Fund the VHTLC via the Golem-built sender.
      const senderDir2 = mkdtempSync(join(tmpdir(), 'golem-e2e-sender2-'));
      const senderWallet2 = await Wallet.create({
        identity: sender,
        arkServerUrl: ARK_URL,
        esploraUrl: CHOPSTICKS_URL,
        storage: new FileSystemStorageAdapter(senderDir2),
      });
      log(`  Sending ${FUND_AMOUNT} sats to VHTLC...`);
      const sendTxid = await senderWallet2.sendBitcoin({ address: vhtlcAddress, amount: FUND_AMOUNT });
      await senderWallet2.dispose();
      log(`  Send txid: ${sendTxid}`);
      mineBlocks(1);
      await sleep(3000);

      // 10. Locate the VHTLC VTXO.
      const vhtlcResult = await indexerProvider.getVtxos({
        scripts: [hex.encode(vhtlcVtxoScript.pkScript)],
        spendableOnly: true,
      });
      if (vhtlcResult.vtxos.length === 0) bail('No VHTLC VTXO observed');
      const vhtlcVtxo = vhtlcResult.vtxos[0];
      log(`  VHTLC VTXO: ${vhtlcVtxo.txid}:${vhtlcVtxo.vout} (${vhtlcVtxo.value} sats)`);

      // 11. Run the handler.
      const result = await handler.processVHTLC({
        vhtlc: {
          txid: vhtlcVtxo.txid,
          vout: vhtlcVtxo.vout,
          value: vhtlcVtxo.value,
          tree: vhtlcVtxoScript,
        },
        preimage,
        serverPubKey: serverPubkey,
        introspectorPubKey: introspectorBasePubkey,
        receiverVtxoScript: receiver.vtxoScript,
        serverUnrollScript,
        introspectorUrl: INTROSPECTOR_URL,
        arkProvider,
      });
      if (result.status !== 'claimed') {
        bail(`Handler returned status=${result.status} error=${result.error?.message ?? '(none)'}`);
      }
      if (result.persistError) bail(`Repo persistence failed: ${result.persistError.message}`);
      log(`  Claim txid: ${result.txid}`);

      mineBlocks(1);
      await sleep(2000);

      // 12. Verify VTXO at our covenant address.
      const claimedResult = await indexerProvider.getVtxos({
        scripts: [hex.encode(receiver.vtxoScript.pkScript)],
        spendableOnly: true,
      });
      const claimedVtxo = claimedResult.vtxos.find(v => v.txid === result.txid && v.vout === result.vout);
      if (!claimedVtxo) bail(`Claimed VTXO not found at receiver pkScript`);
      log(`  Claimed VTXO at receiver: ${claimedVtxo.txid}:${claimedVtxo.vout} (${claimedVtxo.value} sats)`);

      // 13. Confirm repo persisted prevTxBytes.
      const persisted = claimsRepo.getPrevTxBytes(`${result.txid}:${result.vout}`);
      if (!persisted) bail(`No prevTxBytes persisted for ${result.txid}:${result.vout}`);
      log(`  prevTxBytes persisted (${persisted.length} bytes) ✓`);

      return { txid: claimedVtxo.txid, vout: claimedVtxo.vout, value: claimedVtxo.value };
    }

    // Run the claim twice to produce two covenant VTXOs.
    const v1 = await processOneClaim('Claim #1');
    const v2 = await processOneClaim('Claim #2');

    // 14. Refresh v1 alone — exercises repo-backed prevTxBytes lookup.
    log('──── Refresh v1 (single-input, repo-backed prevTxBytes) ────');
    const { txid: refreshTxid1, prevTxBytes: refreshedV1Bytes } = await covenantRefresh({
      vtxos: [{ txid: v1.txid, vout: v1.vout, value: v1.value }],
      vtxoScript: receiver.vtxoScript,
      refreshLeafScript: receiver.refreshLeafScript,
      refreshArkadeScript: receiver.refreshArkadeScript,
      serverUnrollScript,
      introspectorUrl: INTROSPECTOR_URL,
      arkProvider,
      claimsRepo,
    });
    log(`  Refresh txid: ${refreshTxid1}`);
    mineBlocks(1);
    await sleep(2000);
    // The refreshed VTXO is at the same pkScript, new txid.
    const post1 = await indexerProvider.getVtxos({
      scripts: [hex.encode(receiver.vtxoScript.pkScript)],
      spendableOnly: true,
    });
    const refreshedV1 = post1.vtxos.find(v => v.txid === refreshTxid1);
    if (!refreshedV1) bail('refreshed VTXO not observed');
    log(`  Refreshed VTXO observed ✓ (${refreshedV1.txid}:${refreshedV1.vout}, ${refreshedV1.value} sats)`);

    // 15. Consolidate (refreshed v1) with v2 — mixed inline + repo prevTxBytes.
    //     refreshedV1 is NOT in the repo (only the original claim path persists);
    //     covenantRefresh handed us its unsigned arkTx bytes for exactly this
    //     case. v2 is still in the repo from the claim step. This exercises the
    //     prevTxBytes resolution-precedence (inline wins; otherwise repo).
    log('──── Consolidation #1 (refreshedV1 inline + v2 repo) ────');
    const { txid: consTxid1, prevTxBytes: cons1Bytes } = await covenantRefresh({
      vtxos: [
        { txid: refreshedV1.txid, vout: refreshedV1.vout, value: refreshedV1.value, prevTxBytes: refreshedV1Bytes },
        { txid: v2.txid, vout: v2.vout, value: v2.value },
      ],
      vtxoScript: receiver.vtxoScript,
      refreshLeafScript: receiver.refreshLeafScript,
      refreshArkadeScript: receiver.refreshArkadeScript,
      serverUnrollScript,
      introspectorUrl: INTROSPECTOR_URL,
      arkProvider,
      claimsRepo,
    });
    log(`  Consolidation #1 txid: ${consTxid1}`);
    mineBlocks(1);
    await sleep(2000);
    const postCons1 = await indexerProvider.getVtxos({
      scripts: [hex.encode(receiver.vtxoScript.pkScript)],
      spendableOnly: true,
    });
    const cons1 = postCons1.vtxos.find(v => v.txid === consTxid1);
    if (!cons1) bail('consolidated VTXO #1 not observed');
    const expectedConsAmount = refreshedV1.value + v2.value;
    if (cons1.value !== expectedConsAmount) {
      bail(`consolidated VTXO value ${cons1.value} != sum of inputs ${expectedConsAmount}`);
    }
    log(`  Consolidated VTXO #1 observed ✓ (${cons1.value} sats = ${refreshedV1.value} + ${v2.value})`);
    // The 2 input VTXOs must NOT still be spendable (arkd consumed them).
    if (postCons1.vtxos.some(v => v.txid === refreshedV1.txid && v.vout === refreshedV1.vout)) {
      bail('refreshedV1 still spendable after consolidation — arkd did not consume it');
    }
    if (postCons1.vtxos.some(v => v.txid === v2.txid && v.vout === v2.vout)) {
      bail('v2 still spendable after consolidation — arkd did not consume it');
    }
    log(`  Input VTXOs no longer spendable ✓`);

    // 16. Refresh the consolidated VTXO. Proves a consolidated VTXO behaves like
    //     any other covenant VTXO. cons1 isn't in the repo either, so pass inline.
    log('──── Refresh consolidated VTXO (single-input, inline prevTxBytes) ────');
    const { txid: refreshConsTxid, prevTxBytes: cons1RefreshedBytes } = await covenantRefresh({
      vtxos: [{ txid: cons1.txid, vout: cons1.vout, value: cons1.value, prevTxBytes: cons1Bytes }],
      vtxoScript: receiver.vtxoScript,
      refreshLeafScript: receiver.refreshLeafScript,
      refreshArkadeScript: receiver.refreshArkadeScript,
      serverUnrollScript,
      introspectorUrl: INTROSPECTOR_URL,
      arkProvider,
      claimsRepo,
    });
    log(`  Refresh-of-consolidated txid: ${refreshConsTxid}`);
    mineBlocks(1);
    await sleep(2000);
    const postRefreshCons = await indexerProvider.getVtxos({
      scripts: [hex.encode(receiver.vtxoScript.pkScript)],
      spendableOnly: true,
    });
    const cons1Refreshed = postRefreshCons.vtxos.find(v => v.txid === refreshConsTxid);
    if (!cons1Refreshed) bail('refresh-of-consolidated VTXO not observed');
    if (cons1Refreshed.value !== cons1.value) {
      bail(`refresh-of-consolidated value ${cons1Refreshed.value} != original ${cons1.value}`);
    }
    log(`  Refresh-of-consolidated observed ✓ (${cons1Refreshed.value} sats preserved)`);

    // 17. Pull in a fresh claim and re-consolidate. Proves a (refreshed,
    //     previously-consolidated) VTXO can be consolidated again, this time
    //     against a fresh claim still living in the repo.
    log('──── Claim #3 ────');
    const v3 = await processOneClaim('Claim #3');

    log('──── Consolidation #2 (refreshed-consolidated inline + v3 repo) ────');
    const { txid: consTxid2 } = await covenantRefresh({
      vtxos: [
        { txid: cons1Refreshed.txid, vout: cons1Refreshed.vout, value: cons1Refreshed.value, prevTxBytes: cons1RefreshedBytes },
        { txid: v3.txid, vout: v3.vout, value: v3.value },
      ],
      vtxoScript: receiver.vtxoScript,
      refreshLeafScript: receiver.refreshLeafScript,
      refreshArkadeScript: receiver.refreshArkadeScript,
      serverUnrollScript,
      introspectorUrl: INTROSPECTOR_URL,
      arkProvider,
      claimsRepo,
    });
    log(`  Consolidation #2 txid: ${consTxid2}`);
    mineBlocks(1);
    await sleep(2000);
    const postCons2 = await indexerProvider.getVtxos({
      scripts: [hex.encode(receiver.vtxoScript.pkScript)],
      spendableOnly: true,
    });
    const cons2 = postCons2.vtxos.find(v => v.txid === consTxid2);
    if (!cons2) bail('consolidated VTXO #2 not observed');
    const expectedCons2Amount = cons1Refreshed.value + v3.value;
    if (cons2.value !== expectedCons2Amount) {
      bail(`consolidated VTXO #2 value ${cons2.value} != ${expectedCons2Amount}`);
    }
    log(`  Consolidated VTXO #2 observed ✓ (${cons2.value} sats = ${cons1Refreshed.value} + ${v3.value})`);
    // Only the doubly-consolidated VTXO should remain spendable at the receiver address.
    const spendableAtReceiver = postCons2.vtxos.filter(v => v.value > 0);
    log(`  Spendable VTXOs at receiver after lifecycle: ${spendableAtReceiver.length}`);
    if (!spendableAtReceiver.some(v => v.txid === consTxid2)) {
      bail('consolidated VTXO #2 missing from spendable set');
    }

    // 18. Final tally.
    log('=== PASS — claim + refresh + consolidate + refresh-of-consolidate + re-consolidate proven end-to-end ===');
  } finally {
    claimsRepo.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[e2e] FAIL:', err);
  process.exit(1);
});
