/**
 * CovenantClaimHandler — Golem's self-solver path for incoming covenant VHTLCs.
 *
 * Given a candidate VHTLC + recipe parameters, the handler:
 *   1. Detects whether the VHTLC's taproot tree contains a covenant claim leaf
 *      matching our recipe (server pubkey, introspector pubkey, our receive pkScript,
 *      and the preimage hash we generated when requesting the swap).
 *   2. If yes, builds the claim transaction:
 *      - input: the VHTLC outpoint with the revealed covenant leaf + tap tree
 *      - outputs: [0] our covenant receive pkScript with the VHTLC's full value,
 *                 [1] OP_RETURN encoding the enforcePayTo arkade-script + preimage witness.
 *   3. Submits the claim via `submitCovenantTx` (Introspector + arkd co-sign flow).
 *   4. Persists `(claimTxid:0, arkTx.unsignedTx)` to `CovenantClaimsRepo` so future
 *      refreshes of the resulting VTXO can populate the `prevarktx` TLV without
 *      needing the original bytes in memory.
 *
 * Mirrors the regtest pattern in test/regtest/covenant-claim.ts but consumes an
 * EXTERNAL VHTLC (e.g. Fulmine's NonInteractiveClaim via PR #411) rather than one
 * we hand-built.
 *
 * If the detection step fails (no matching leaf), returns `status: 'not-covenant'`
 * so the caller can fall through to standard SwapManager claim. If the submission
 * step throws, returns `status: 'error'` with the captured error and persists
 * nothing. If persistence throws after a successful claim, returns
 * `status: 'claimed'` with `persistError` populated so the caller can decide.
 */

import { hex } from '@scure/base';
import { buildOffchainTx, VtxoScript } from '@arkade-os/sdk';
import type { ArkProvider, CSVMultisigTapscript } from '@arkade-os/sdk';
import { hash160 } from './crypto.js';
import { buildOpReturnScript, encodeWitnessStack } from './introspector-packet.js';
import { findCovenantClaimLeaf } from './vhtlc-detection.js';
import { submitCovenantTx } from './introspector.js';
import type { CovenantClaimsRepo } from '../storage/covenant-claims-repo.js';

export interface ProcessVHTLCParams {
  /** The incoming VHTLC to evaluate. */
  vhtlc: {
    txid: string;
    vout: number;
    value: number;
    /** VtxoScript over the VHTLC's full taproot tree. Detection iterates its leaves. */
    tree: VtxoScript;
  };
  /** The 32-byte preimage Golem generated when requesting the swap. */
  preimage: Uint8Array;
  /** Ark server's signing pubkey (32-byte x-only). */
  serverPubKey: Uint8Array;
  /** Introspector's BASE pubkey (32-byte x-only, untweaked). */
  introspectorPubKey: Uint8Array;
  /** Our covenant receive VtxoScript — where the claim's value should land. */
  receiverVtxoScript: VtxoScript;
  /** The CSV multisig closure used for arkd's checkpoint server signer. */
  serverUnrollScript: CSVMultisigTapscript.Type;
  introspectorUrl: string;
  arkProvider: ArkProvider;
}

export interface ProcessVHTLCResult {
  status: 'claimed' | 'not-covenant' | 'error';
  /** The claim tx's txid on success. */
  txid?: string;
  /** The vout that received our covenant funds (always 0 — output[1] is OP_RETURN). */
  vout?: number;
  /** Bytes persisted to the repo as prevTxBytes for the resulting VTXO. */
  prevTxBytes?: Uint8Array;
  /** Populated when submitCovenantTx fails. */
  error?: Error;
  /** Populated when the claim succeeded but persistence (repo write) failed.
   *  The claim is on-chain regardless — caller must reconcile. */
  persistError?: Error;
}

export class CovenantClaimHandler {
  constructor(private readonly claimsRepo: CovenantClaimsRepo) {}

  async processVHTLC(params: ProcessVHTLCParams): Promise<ProcessVHTLCResult> {
    const {
      vhtlc, preimage, serverPubKey, introspectorPubKey,
      receiverVtxoScript, serverUnrollScript, introspectorUrl, arkProvider,
    } = params;

    // 1. Detect.
    const candidateScripts = vhtlc.tree.scripts;
    const preimageHash = hash160(preimage);
    const found = findCovenantClaimLeaf(candidateScripts, {
      serverPubKey,
      introspectorPubKey,
      receiverPkScript: receiverVtxoScript.pkScript,
      preimageHash,
    });
    if (!found) {
      return { status: 'not-covenant' };
    }

    // 2. Build the claim tx.
    //    OP_RETURN bundles the enforcePayTo arkade-script with the preimage witness,
    //    using the Introspector Packet format (Golem's existing buildOpReturnScript).
    const opReturn = buildOpReturnScript([
      {
        vin: 0,
        script: found.enforcePayToScript,
        witness: encodeWitnessStack([preimage]),
      },
    ]);

    const covenantLeaf = vhtlc.tree.findLeaf(hex.encode(found.leafScript));
    const claimInput = {
      txid: vhtlc.txid,
      vout: vhtlc.vout,
      value: vhtlc.value,
      tapLeafScript: covenantLeaf,
      tapTree: vhtlc.tree.encode(),
    };
    const claimOutputs = [
      { amount: BigInt(vhtlc.value), script: receiverVtxoScript.pkScript },
      { amount: 0n, script: opReturn },
    ];

    const { arkTx, checkpoints } = buildOffchainTx([claimInput], claimOutputs, serverUnrollScript);

    // 3. Capture prevTxBytes BEFORE submission. The bytes don't change during
    //    submission (arkd only adds signatures), so we can persist them either
    //    side of the submit — capturing here keeps the value scoped tightly to
    //    the success path.
    const prevTxBytes = new Uint8Array(arkTx.unsignedTx);

    // 4. Submit.
    let claimTxid: string;
    try {
      claimTxid = await submitCovenantTx({
        introspectorUrl, arkTx, checkpoints, arkProvider,
      });
    } catch (e: any) {
      return { status: 'error', error: e instanceof Error ? e : new Error(String(e)) };
    }

    // 5. Persist. Claim is already on-chain at this point; persistence failure
    //    surfaces in the result but does not invalidate the claim.
    const newOutpoint = `${claimTxid}:0`;
    try {
      this.claimsRepo.recordClaim(newOutpoint, prevTxBytes);
      return { status: 'claimed', txid: claimTxid, vout: 0, prevTxBytes };
    } catch (e: any) {
      return {
        status: 'claimed',
        txid: claimTxid,
        vout: 0,
        prevTxBytes,
        persistError: e instanceof Error ? e : new Error(String(e)),
      };
    }
  }
}
