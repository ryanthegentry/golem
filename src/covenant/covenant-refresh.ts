/**
 * Covenant refresh and consolidation — keyless VTXO lifecycle operations.
 * Uses Introspector for signing (no private key needed).
 */

import { buildOffchainTx, VtxoScript } from '@arkade-os/sdk';
import type { ArkProvider, CSVMultisigTapscript } from '@arkade-os/sdk';
import { buildOpReturnScript } from './introspector-packet.js';
import { submitCovenantTx } from './introspector.js';
import type { CovenantClaimsRepo } from '../storage/covenant-claims-repo.js';

/**
 * Resolve the `prevTxBytes` for a given vtxo input. Resolution order:
 *   1. inline `prevTxBytes` (legacy regtest behavior — preserved)
 *   2. repo lookup by outpoint (new — production path with CovenantClaimsRepo)
 *   3. throw — ONLY when a repo was provided but neither inline nor repo has bytes.
 *      Callers without a repo keep the legacy "leave field unset" semantics so
 *      existing regtest scripts (`covenant-claim.ts`, `covenant-lifecycle.ts`) don't
 *      regress.
 */
export function resolvePrevTxBytes(
  inline: Uint8Array | undefined,
  outpoint: string,
  repo: CovenantClaimsRepo | undefined,
): Uint8Array | undefined {
  if (inline) return inline;
  if (!repo) return undefined;
  const fromRepo = repo.getPrevTxBytes(outpoint);
  if (fromRepo) return fromRepo;
  throw new Error(
    `covenantRefresh: prevTxBytes not found inline or in CovenantClaimsRepo for outpoint ${outpoint}`,
  );
}

/**
 * Refresh or consolidate covenant VTXOs via the Introspector 4-step flow.
 * Single-input = refresh, multi-input = consolidation. Same code path.
 *
 * Per-input prevTxBytes are required for OP_INSPECTINPUTSCRIPTPUBKEY (PR #63). They
 * can be supplied inline on each vtxo (regtest pattern) or fetched from a
 * `CovenantClaimsRepo` written at claim time (production pattern).
 */
export async function covenantRefresh(params: {
  vtxos: Array<{ txid: string; vout: number; value: number; prevTxBytes?: Uint8Array }>;
  vtxoScript: VtxoScript;
  refreshLeafScript: Uint8Array;
  refreshArkadeScript: Uint8Array;
  serverUnrollScript: CSVMultisigTapscript.Type;
  introspectorUrl: string;
  arkProvider: ArkProvider;
  claimsRepo?: CovenantClaimsRepo;
}): Promise<string> {
  const {
    vtxos, vtxoScript, refreshLeafScript, refreshArkadeScript,
    serverUnrollScript, introspectorUrl, arkProvider, claimsRepo,
  } = params;

  const refreshLeaf = vtxoScript.findLeaf(
    Array.from(refreshLeafScript).map(b => b.toString(16).padStart(2, '0')).join(''),
  );
  const encodedTree = vtxoScript.encode();

  const inputs = vtxos.map(v => ({
    txid: v.txid,
    vout: v.vout,
    value: v.value,
    tapLeafScript: refreshLeaf,
    tapTree: encodedTree,
  }));

  const totalValue = vtxos.reduce((sum, v) => sum + v.value, 0);

  const opReturn = buildOpReturnScript(
    vtxos.map((_, i) => ({ vin: i, script: refreshArkadeScript })),
  );

  const outputs = [
    { amount: BigInt(totalValue), script: vtxoScript.pkScript },
    { amount: 0n, script: opReturn },
  ];

  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, serverUnrollScript);

  // Set PrevArkTxField for inputs that need OP_INSPECTINPUTSCRIPTPUBKEY resolution.
  // The Introspector uses this to look up the input's previous output scriptPubKey.
  const prevArkTxKey = new TextEncoder().encode('prevarktx');
  for (let i = 0; i < vtxos.length; i++) {
    const outpoint = `${vtxos[i].txid}:${vtxos[i].vout}`;
    const prevBytes = resolvePrevTxBytes(vtxos[i].prevTxBytes, outpoint, claimsRepo);
    if (prevBytes) {
      arkTx.updateInput(i, {
        unknown: [
          ...(arkTx.getInput(i)?.unknown ?? []),
          [{ type: 0xde, key: prevArkTxKey }, prevBytes],
        ],
      });
    }
  }

  return submitCovenantTx({ introspectorUrl, arkTx, checkpoints, arkProvider });
}
