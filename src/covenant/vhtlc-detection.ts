/**
 * vhtlc-detection — covenant claim leaf detection for incoming VHTLC trees.
 *
 * Detects the NonInteractiveClaim covenant leaf shape introduced in ArkLabsHQ/fulmine
 * PR #411. The detector reconstructs the EXPECTED leaf bytes from the recipe parameters
 * (server pubkey, introspector pubkey, our receive pkScript, the preimage hash we generated)
 * and compares against candidate leaves in the tree.
 *
 * Match is byte-exact. This is robust because three independent implementations
 * (Fulmine PR #411, ts-sdk PR #396 CovVHTLC, Golem's own primitives) converge on the
 * same script topology. If Boltz eventually adopts a divergent shape, the refactor
 * scope is contained to this file.
 *
 * Distinct from `vtxo-detection.ts`, which classifies VTXOs already at our covenant
 * address; this module classifies leaves in incoming VHTLC trees from the wire.
 */

import { ConditionMultisigTapscript } from '@arkade-os/sdk';
import { arkadeScriptHash, computeTweakedKey } from './crypto.js';

/** Recipe inputs for the covenant claim leaf — everything the receiver knows a priori. */
export interface CovenantLeafRecipe {
  /** Server's x-only pubkey (32 bytes). */
  serverPubKey: Uint8Array;
  /** Introspector's BASE x-only pubkey (32 bytes), untweaked. */
  introspectorPubKey: Uint8Array;
  /** Our covenant receive pkScript (34-byte P2TR: 0x51 0x20 ...witnessProgram). */
  receiverPkScript: Uint8Array;
  /** HASH160(preimage) — 20 bytes — committed by the receiver when requesting the swap. */
  preimageHash: Uint8Array;
}

/** Materialized expected leaf with all intermediate artifacts (useful for claim-time witness building). */
export interface CovenantLeafDescriptor {
  /** Introspector pubkey tweaked by arkadeScriptHash(enforcePayToScript). */
  introspectorTweakedKey: Uint8Array;
  /** Arkade enforcement script — matches PR #411 enforcePayTo. */
  enforcePayToScript: Uint8Array;
  /** Condition script: HASH160 <preimageHash> EQUAL. */
  conditionScript: Uint8Array;
  /** Full ConditionMultisig leaf script bytes. */
  leafScript: Uint8Array;
}

/**
 * Build the Arkade enforcement script that pins output[currentInputIndex].pkScript
 * to receiverPkScript AND output[i].value >= input[i].value.
 *
 * Byte-for-byte matches ArkLabsHQ/fulmine PR #411 enforcePayTo:
 *   OP_PUSHCURRENTINPUTINDEX  (0xcd)
 *   OP_DUP                    (0x76)
 *   OP_INSPECTOUTPUTSCRIPTPUBKEY (0xd1)
 *   OP_1                      (0x51)
 *   OP_EQUALVERIFY            (0x88)
 *   PUSH <32-byte WP>         (0x20 ...)
 *   OP_EQUALVERIFY            (0x88)
 *   OP_INSPECTOUTPUTVALUE     (0xcf)
 *   OP_PUSHCURRENTINPUTINDEX  (0xcd)
 *   OP_INSPECTINPUTVALUE      (0xc9)
 *   OP_GREATERTHANOREQUAL     (0xa2)
 */
export function buildNonInteractiveClaimArkadeScript(receiverPkScript: Uint8Array): Uint8Array {
  if (receiverPkScript.length !== 34) {
    throw new Error(`receiverPkScript must be 34-byte P2TR pkScript, got ${receiverPkScript.length}`);
  }
  if (receiverPkScript[0] !== 0x51 || receiverPkScript[1] !== 0x20) {
    throw new Error('receiverPkScript is not P2TR (expected leading 0x51 0x20)');
  }
  const wp = receiverPkScript.slice(2);
  return new Uint8Array([
    0xcd, 0x76, 0xd1, 0x51, 0x88,
    0x20, ...wp,
    0x88,
    0xcf, 0xcd, 0xc9, 0xa2,
  ]);
}

/** Build the expected covenant claim leaf for given recipe parameters. */
export function buildCovenantClaimLeaf(recipe: CovenantLeafRecipe): CovenantLeafDescriptor {
  validateRecipe(recipe);
  const enforcePayToScript = buildNonInteractiveClaimArkadeScript(recipe.receiverPkScript);
  const tweak = arkadeScriptHash(enforcePayToScript);
  const introspectorTweakedKey = computeTweakedKey(recipe.introspectorPubKey, tweak);
  // HASH160 <preimageHash> EQUAL — the condition closure leaves a boolean on the stack.
  const conditionScript = new Uint8Array([0xa9, 0x14, ...recipe.preimageHash, 0x87]);
  const leafScript = ConditionMultisigTapscript.encode({
    conditionScript,
    pubkeys: [recipe.serverPubKey, introspectorTweakedKey],
  }).script;
  return { introspectorTweakedKey, enforcePayToScript, conditionScript, leafScript };
}

/**
 * Look for the expected covenant claim leaf in a list of candidate tap leaf scripts.
 * Returns the descriptor (including bytes we need at claim time) when found, else null.
 */
export function findCovenantClaimLeaf(
  candidateScripts: Uint8Array[],
  recipe: CovenantLeafRecipe,
): CovenantLeafDescriptor | null {
  const expected = buildCovenantClaimLeaf(recipe);
  for (const candidate of candidateScripts) {
    if (bytesEqual(candidate, expected.leafScript)) {
      return expected;
    }
  }
  return null;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function validateRecipe(r: CovenantLeafRecipe): void {
  if (r.serverPubKey.length !== 32) {
    throw new Error(`serverPubKey must be 32-byte x-only, got ${r.serverPubKey.length}`);
  }
  if (r.introspectorPubKey.length !== 32) {
    throw new Error(`introspectorPubKey must be 32-byte x-only, got ${r.introspectorPubKey.length}`);
  }
  if (r.receiverPkScript.length !== 34) {
    throw new Error(`receiverPkScript must be 34-byte P2TR, got ${r.receiverPkScript.length}`);
  }
  if (r.preimageHash.length !== 20) {
    throw new Error(`preimageHash must be 20-byte HASH160, got ${r.preimageHash.length}`);
  }
}
