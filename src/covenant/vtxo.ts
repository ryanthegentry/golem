/**
 * Covenant VTXO builder.
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

import {
  VtxoScript,
  CSVMultisigTapscript,
  MultisigTapscript,
} from '@arkade-os/sdk';
import { buildRefreshArkadeScript } from './arkade-script.js';
import { arkadeScriptHash, computeTweakedKey } from './crypto.js';

export function buildCovenantVtxo(params: {
  alicePubkey: Uint8Array;              // 32-byte x-only (imported from mobile wallet)
  serverPubkey: Uint8Array;             // 32-byte x-only (from arkd /v1/info)
  introspectorBasePubkey: Uint8Array;   // 32-byte x-only (from introspector /v1/info)
  unilateralExitDelay: bigint;
}): {
  vtxoScript: VtxoScript;
  refreshArkadeScript: Uint8Array;
  refreshTweakedKey: Uint8Array;
  refreshLeafScript: Uint8Array;
  collaborativeScript: Uint8Array;
} {
  const { alicePubkey, serverPubkey, introspectorBasePubkey, unilateralExitDelay } = params;

  // Leaf 0: Covenant refresh — Introspector-enforced, no private key needed.
  const refreshArkadeScript = buildRefreshArkadeScript();
  const refreshScriptHash = arkadeScriptHash(refreshArkadeScript);
  const refreshTweakedKey = computeTweakedKey(introspectorBasePubkey, refreshScriptHash);
  const refreshLeafScript = MultisigTapscript.encode({
    pubkeys: [refreshTweakedKey, serverPubkey],
  }).script;

  // Leaf 1: Collaborative (alice + server for spending and Ark protocol ops)
  const collaborativeScript = MultisigTapscript.encode({
    pubkeys: [alicePubkey, serverPubkey],
  }).script;

  // Leaf 2: Unilateral exit (alice + CSV timelock for emergency)
  const unilateralExitScript = CSVMultisigTapscript.encode({
    timelock: { type: 'seconds', value: unilateralExitDelay },
    pubkeys: [alicePubkey],
  }).script;

  const vtxoScript = new VtxoScript([
    refreshLeafScript,
    collaborativeScript,
    unilateralExitScript,
  ]);

  return { vtxoScript, refreshArkadeScript, refreshTweakedKey, refreshLeafScript, collaborativeScript };
}
