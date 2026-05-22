import { hex, base64 } from '@scure/base';
import { Transaction } from '@arkade-os/sdk';

// The PSBT from the last test run - extract from test output
// Let's build a fresh one to inspect
import 'fake-indexeddb/auto';
import { EventSource } from 'eventsource';
Object.assign(globalThis, { EventSource });

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
import crypto from 'node:crypto';
import {
  buildClaimArkadeScript,
  buildRefreshArkadeScript,
  arkadeScriptHash,
  computeTweakedKey,
  buildOpReturnScript,
  encodeWitnessStack,
  buildCovenantVtxo,
} from '../../src/covenant/index.js';

const ARK_URL = 'http://localhost:7070';
const INTROSPECTOR_URL = 'http://localhost:7073';
const FUND_AMOUNT = 10_000;

async function main() {
  const arkProvider = new RestArkProvider(ARK_URL);
  const info = await arkProvider.getInfo();
  const serverPubkey = hex.decode(info.signerPubkey).slice(1);
  const introspectorBasePubkey = hex.decode((await fetch(`${INTROSPECTOR_URL}/v1/info`).then(r => r.json()) as any).signerPubkey).slice(1);
  const serverUnrollScript = CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript));

  // Generate keys
  const alice = SingleKey.fromRandomBytes();
  const alicePubkey = await alice.xOnlyPublicKey();
  const sender = SingleKey.fromRandomBytes();
  const senderPubkey = await sender.xOnlyPublicKey();

  // Build covenant VTXO
  const { vtxoScript: recipientVtxo } = buildCovenantVtxo({
    alicePubkey, serverPubkey, introspectorBasePubkey,
    unilateralExitDelay: BigInt(info.unilateralExitDelay),
  });

  // Build VHTLC
  const preimage = crypto.randomBytes(32);
  const preimageHash = new Uint8Array(crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(preimage).digest()).digest());
  const recipientWitnessProgram = recipientVtxo.pkScript.slice(2);
  const claimArkadeScript = buildClaimArkadeScript(preimageHash, recipientWitnessProgram, BigInt(FUND_AMOUNT));
  const claimTweakedKey = computeTweakedKey(introspectorBasePubkey, arkadeScriptHash(claimArkadeScript));

  const conditionScript = Script.encode(['HASH160', preimageHash, 'EQUAL']);
  const covenantClaimScript = MultisigTapscript.encode({ pubkeys: [claimTweakedKey, serverPubkey] }).script;
  const standardClaimScript = ConditionMultisigTapscript.encode({
    conditionScript, pubkeys: [alicePubkey, serverPubkey],
  }).script;
  const refundScript = MultisigTapscript.encode({ pubkeys: [senderPubkey, alicePubkey, serverPubkey] }).script;
  const unilateralClaimScript = (() => {
    const csvScript = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 512n }, pubkeys: [alicePubkey] }).script;
    return new Uint8Array([...conditionScript, ...Script.encode(['VERIFY']), ...csvScript]);
  })();
  const unilateralRefundScript = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 1024n }, pubkeys: [senderPubkey] }).script;
  const unilateralRefundNoRecvScript = CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 1536n }, pubkeys: [senderPubkey] }).script;

  const vhtlcScript = new VtxoScript([
    covenantClaimScript,
    standardClaimScript,
    refundScript,
    unilateralClaimScript,
    unilateralRefundScript,
    unilateralRefundNoRecvScript,
  ]);

  // Get the pkScript and inspect internal key
  const vhtlcAddress = vhtlcScript.address(networks.regtest.hrp, serverPubkey);
  console.log('VHTLC address:', vhtlcAddress.encode());
  console.log('VHTLC pkScript:', hex.encode(vhtlcScript.pkScript));
  console.log('VHTLC encoded taptree:', hex.encode(vhtlcScript.encode()));

  // Get the covenant claim leaf 
  const covenantLeaf = vhtlcScript.findLeaf(hex.encode(covenantClaimScript));
  console.log('\nCovenant claim leaf:');
  console.log('  script:', hex.encode(covenantLeaf.script));
  console.log('  controlBlock:', hex.encode(covenantLeaf.controlBlock));

  // Parse control block
  const cb = covenantLeaf.controlBlock;
  const version = cb[0];
  const internalKey = cb.slice(1, 33);
  const merklePath = [];
  for (let i = 33; i < cb.length; i += 32) {
    merklePath.push(cb.slice(i, i + 32));
  }
  console.log('  CB version:', version, `(0x${version.toString(16)})`);
  console.log('  CB internalKey:', hex.encode(internalKey));
  console.log('  CB merkle path hashes:', merklePath.length);
  for (const h of merklePath) {
    console.log('    ', hex.encode(h));
  }
  
  // The unspendable key from arkd
  const unspendableKeyXOnly = [
    '50929b74c1a04954b78b4b6035e97a5e',
    '078a5a0f28ec96d547bfee9ace803ac0',
  ].join('');
  console.log('\nExpected (arkd) internal key:', unspendableKeyXOnly);
  console.log('Control block internal key:', hex.encode(internalKey));
  console.log('MATCH:', hex.encode(internalKey) === unspendableKeyXOnly);

  // Build a dummy offchain tx to check the checkpoint structure
  const dummyInput = {
    txid: '0000000000000000000000000000000000000000000000000000000000000001',
    vout: 0,
    value: FUND_AMOUNT,
    tapLeafScript: covenantLeaf,
    tapTree: vhtlcScript.encode(),
  };
  const dummyOutputs = [
    { amount: BigInt(FUND_AMOUNT), script: recipientVtxo.pkScript },
    { amount: 0n, script: new Uint8Array([0x6a]) }, // OP_RETURN placeholder
  ];
  const { arkTx, checkpoints } = buildOffchainTx([dummyInput], dummyOutputs, serverUnrollScript);

  // Inspect ark tx PSBT
  const psbtBytes = arkTx.toPSBT();
  const tx = Transaction.fromPSBT(psbtBytes);
  console.log('\n=== Ark TX PSBT ===');
  console.log('Inputs:', tx.inputsLength, 'Outputs:', tx.outputsLength);
  
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    console.log(`\nInput ${i}:`);
    if (inp.witnessUtxo) {
      console.log('  witnessUtxo.script:', hex.encode(inp.witnessUtxo.script!));
      console.log('  witnessUtxo.amount:', inp.witnessUtxo.amount);
    }
    if (inp.tapLeafScript) {
      const tls = inp.tapLeafScript as any;
      // Try different access patterns
      if (Array.isArray(tls)) {
        for (const [idx, leaf] of tls.entries()) {
          console.log(`  tapLeafScript[${idx}].script:`, hex.encode(leaf.script));
          console.log(`  tapLeafScript[${idx}].controlBlock:`, hex.encode(leaf.controlBlock));
          const v = leaf.controlBlock[0];
          const ik = leaf.controlBlock.slice(1, 33);
          console.log(`  tapLeafScript[${idx}].CB.internalKey:`, hex.encode(ik));
          console.log(`  tapLeafScript[${idx}].CB.version:`, v, `(0x${v.toString(16)})`);
        }
      } else {
        console.log('  tapLeafScript type:', typeof tls, Object.keys(tls));
      }
    }
  }

  // Also inspect checkpoint PSBT
  if (checkpoints.length > 0) {
    const cpPsbt = checkpoints[0].toPSBT();
    const cpTx = Transaction.fromPSBT(cpPsbt);
    console.log('\n=== Checkpoint 0 PSBT ===');
    console.log('Inputs:', cpTx.inputsLength, 'Outputs:', cpTx.outputsLength);
    for (let i = 0; i < cpTx.inputsLength; i++) {
      const inp = cpTx.getInput(i);
      console.log(`\nInput ${i}:`);
      if (inp.witnessUtxo) {
        console.log('  witnessUtxo.script:', hex.encode(inp.witnessUtxo.script!));
      }
      if (inp.tapLeafScript) {
        const tls = inp.tapLeafScript as any;
        if (Array.isArray(tls)) {
          for (const [idx, leaf] of tls.entries()) {
            console.log(`  tapLeafScript[${idx}].script:`, hex.encode(leaf.script));
            const v = leaf.controlBlock[0];
            const ik = leaf.controlBlock.slice(1, 33);
            console.log(`  tapLeafScript[${idx}].CB.internalKey:`, hex.encode(ik));
          }
        }
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
