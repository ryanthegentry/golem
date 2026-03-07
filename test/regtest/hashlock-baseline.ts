/**
 * Phase 1: Hashlock baseline test on regtest.
 *
 * Creates a VHTLC using the SDK's built-in VHTLC.Script class,
 * funds it via boarding, and claims via the collaborative path
 * (preimage + receiver sig + server sig).
 *
 * Prerequisites:
 *   nigiri start --ark --ci
 *
 * Run:
 *   npx tsx test/regtest/hashlock-baseline.ts
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
  Transaction,
  VHTLC,
  DefaultVtxo,
  buildOffchainTx,
  setArkPsbtField,
  ConditionWitness,
  networks,
} from '@arkade-os/sdk';
import { FileSystemStorageAdapter } from '@arkade-os/sdk/adapters/fileSystem';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

// ─── Configuration ───────────────────────────────────────────────────────────

const ARK_URL = 'http://localhost:7070';
const CHOPSTICKS_URL = 'http://localhost:3000';
const FUND_AMOUNT = 10_000; // sats to lock in VHTLC
const BOARDING_AMOUNT = 0.001; // BTC to board (100_000 sats)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[hashlock] ${msg}`);
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
  log('Starting hashlock baseline test on regtest');

  // 1. Connect to arkd and get server info
  const arkProvider = new RestArkProvider(ARK_URL);
  const info = await arkProvider.getInfo();
  log(`Connected to arkd ${info.version} on ${info.network}`);

  const serverPubkey = hex.decode(info.signerPubkey).slice(1); // x-only (32 bytes)
  log(`Server pubkey (x-only): ${hex.encode(serverPubkey)}`);
  log(`Unilateral exit delay: ${info.unilateralExitDelay}`);

  // 2. Create sender and receiver identities
  const sender = SingleKey.fromRandomBytes();
  const receiver = SingleKey.fromRandomBytes();
  const senderPubkey = await sender.xOnlyPublicKey();
  const receiverPubkey = await receiver.xOnlyPublicKey();
  log(`Sender pubkey: ${hex.encode(senderPubkey)}`);
  log(`Receiver pubkey: ${hex.encode(receiverPubkey)}`);

  // 3. Create preimage and hash
  const preimage = crypto.randomBytes(32);
  const preimageHash = hash160(preimage);
  log(`Preimage: ${hex.encode(preimage)}`);
  log(`Preimage hash (HASH160): ${hex.encode(preimageHash)}`);

  // 4. Get refund locktime as Unix timestamp (CLTV block type not allowed by arkd)
  const refundLocktime = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
  log(`Refund locktime (unix): ${refundLocktime}`);

  // 5. Build VHTLC using SDK's built-in class
  const vhtlc = new VHTLC.Script({
    sender: senderPubkey,
    receiver: receiverPubkey,
    server: serverPubkey,
    preimageHash,
    refundLocktime,
    unilateralClaimDelay: { type: 'seconds', value: 512n },
    unilateralRefundDelay: { type: 'seconds', value: 1024n },
    unilateralRefundWithoutReceiverDelay: { type: 'seconds', value: 1536n },
  });

  const vhtlcAddress = vhtlc.address(networks.regtest.hrp, serverPubkey).encode();
  log(`VHTLC address: ${vhtlcAddress}`);
  log(`VHTLC claim script: ${vhtlc.claimScript}`);

  // 6. Create sender wallet and fund it
  const senderDataDir = mkdtempSync(join(tmpdir(), 'golem-sender-'));
  const senderWallet = await Wallet.create({
    identity: sender,
    arkServerUrl: ARK_URL,
    esploraUrl: CHOPSTICKS_URL,
    storage: new FileSystemStorageAdapter(senderDataDir),
  });

  const boardingAddress = await senderWallet.getBoardingAddress();
  log(`Sender boarding address: ${boardingAddress}`);

  // Fund the boarding address
  log('Funding sender via nigiri faucet...');
  const faucetOutput = nigiriFaucet(boardingAddress, BOARDING_AMOUNT);
  log(`Faucet: ${faucetOutput}`);

  // Mine blocks to confirm the on-chain tx
  log('Mining blocks for confirmation...');
  mineBlocks(3);
  await sleep(3000);

  // Debug: check chopsticks directly
  const resp = await fetch(`${CHOPSTICKS_URL}/address/${boardingAddress}/utxo`);
  const utxosOnChain = await resp.json();
  log(`Chopsticks UTXOs for boarding address: ${JSON.stringify(utxosOnChain)}`);

  // Check boarding UTXOs via SDK
  let boardingUtxos = await senderWallet.getBoardingUtxos();
  log(`Boarding UTXOs (SDK): ${boardingUtxos.length}`);

  // If empty, wait more and retry
  if (boardingUtxos.length === 0) {
    log('No boarding UTXOs yet, waiting longer...');
    mineBlocks(3);
    await sleep(5000);
    boardingUtxos = await senderWallet.getBoardingUtxos();
    log(`Boarding UTXOs (retry): ${boardingUtxos.length}`);
  }

  if (boardingUtxos.length === 0) {
    throw new Error('No boarding UTXOs found after faucet');
  }
  log(`Boarding UTXO value: ${boardingUtxos[0].value} sats`);

  // 7. Board funds into Ark
  log('Boarding funds into Ark...');
  const ramps = new Ramps(senderWallet);

  const boardingTxid = await ramps.onboard(info.fees, undefined, undefined, (event) => {
    log(`  Boarding event: ${event.type ?? 'unknown'}`);
  });
  log(`Boarding txid: ${boardingTxid}`);

  // Mine blocks and wait for settlement
  mineBlocks(2);
  await sleep(3000);

  // Check sender balance
  const senderBalance = await senderWallet.getBalance();
  log(`Sender balance: ${JSON.stringify(senderBalance, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);

  // Check sender VTXOs directly
  const senderVtxos = await senderWallet.getVtxos();
  log(`Sender VTXOs: ${senderVtxos.length}`);
  if (senderVtxos.length === 0) {
    throw new Error('Sender has no VTXOs after boarding');
  }
  log(`Sender VTXO[0] value: ${senderVtxos[0].value} sats`);

  // 8. Send to the VHTLC address
  log(`Sending ${FUND_AMOUNT} sats to VHTLC address...`);
  const sendTxid = await senderWallet.sendBitcoin({
    address: vhtlcAddress,
    amount: FUND_AMOUNT,
  });
  log(`Send txid: ${sendTxid}`);

  // Wait for the VTXO to appear
  mineBlocks(1);
  await sleep(3000);

  // 9. Query for VHTLC VTXOs
  const indexerProvider = new RestIndexerProvider(ARK_URL);
  const result = await indexerProvider.getVtxos({
    scripts: [hex.encode(vhtlc.pkScript)],
    spendableOnly: true,
  });

  log(`VHTLC VTXOs found: ${result.vtxos.length}`);
  if (result.vtxos.length === 0) {
    throw new Error('No VTXOs found at VHTLC script');
  }

  const vtxo = result.vtxos[0];
  log(`VHTLC VTXO: txid=${vtxo.txid}, vout=${vtxo.vout}, value=${vtxo.value}`);

  // 10. Build the offchain claim transaction
  log('Building claim transaction...');

  // Decode the server's checkpoint/unroll script
  const serverUnrollScript = CSVMultisigTapscript.decode(
    hex.decode(info.checkpointTapscript)
  );

  // Recipient: receiver's default Ark VtxoScript
  const recipientVtxo = new DefaultVtxo.Script({
    pubKey: receiverPubkey,
    serverPubKey: serverPubkey,
  });

  const input = {
    txid: vtxo.txid,
    vout: vtxo.vout,
    value: vtxo.value,
    tapLeafScript: vhtlc.claim(), // collaborative claim path
    tapTree: vhtlc.encode(),
  };

  const outputs = [
    { amount: BigInt(vtxo.value), script: recipientVtxo.pkScript },
  ];

  const { arkTx, checkpoints } = buildOffchainTx(
    [input],
    outputs,
    serverUnrollScript,
  );

  // 11. Add preimage as ConditionWitness and sign the claim transaction
  log('Adding preimage ConditionWitness and signing claim transaction...');
  setArkPsbtField(arkTx, 0, ConditionWitness, [preimage]);
  const psbt = arkTx.toPSBT();
  const tx = Transaction.fromPSBT(psbt);
  const signedTx = await receiver.sign(tx);
  log('Receiver signed the claim tx (with preimage witness)');

  // 12. Submit to arkd for server co-signing
  log('Submitting claim tx to arkd...');
  const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signedTx.toPSBT()),
    checkpoints.map(c => base64.encode(c.toPSBT())),
  );
  log(`Claim submitted! arkTxid: ${arkTxid}`);

  // 13. Finalize checkpoints
  log('Finalizing checkpoints...');
  const finalCheckpoints = await Promise.all(
    signedCheckpointTxs.map(async (cpB64: string) => {
      const cpTx = Transaction.fromPSBT(base64.decode(cpB64));
      // Checkpoint also uses the VHTLC claim path — needs preimage witness
      setArkPsbtField(cpTx, 0, ConditionWitness, [preimage]);
      const signed = await receiver.sign(cpTx, [0]);
      return base64.encode(signed.toPSBT());
    }),
  );

  await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
  log('Checkpoints finalized!');

  // 14. Verify the claimed VTXO
  mineBlocks(1);
  await sleep(2000);

  const claimedResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(recipientVtxo.pkScript)],
    spendableOnly: true,
  });

  log(`Claimed VTXOs at receiver: ${claimedResult.vtxos.length}`);
  if (claimedResult.vtxos.length === 0) {
    throw new Error('No claimed VTXOs found at recipient script');
  }

  const claimedVtxo = claimedResult.vtxos[0];
  log(`Claimed VTXO: txid=${claimedVtxo.txid}, vout=${claimedVtxo.vout}, value=${claimedVtxo.value}`);

  // Verify the original VHTLC is spent
  const spentResult = await indexerProvider.getVtxos({
    scripts: [hex.encode(vhtlc.pkScript)],
    spendableOnly: true,
  });
  log(`Remaining VHTLC VTXOs: ${spentResult.vtxos.length} (should be 0)`);

  log('');
  log('=== PHASE 1 COMPLETE ===');
  log(`  VHTLC registered, funded, claimed via collaborative path on regtest`);
  log(`  Claimed VTXO: ${claimedVtxo.txid}:${claimedVtxo.vout} (${claimedVtxo.value} sats)`);
}

main().catch((err) => {
  console.error('[hashlock] FAILED:', err);
  process.exit(1);
});
