/**
 * Covenant refresh and consolidation — keyless VTXO lifecycle operations.
 * Uses Introspector for signing (no private key needed).
 */

import { buildOffchainTx, VtxoScript } from '@arkade-os/sdk';
import type { ArkProvider, CSVMultisigTapscript } from '@arkade-os/sdk';
import { buildOpReturnScript } from './introspector-packet.js';
import { submitCovenantTx } from './introspector.js';

/**
 * Refresh or consolidate covenant VTXOs via the Introspector 4-step flow.
 * Single-input = refresh, multi-input = consolidation. Same code path.
 */
export async function covenantRefresh(params: {
  vtxos: Array<{ txid: string; vout: number; value: number; prevTxBytes?: Uint8Array }>;
  vtxoScript: VtxoScript;
  refreshLeafScript: Uint8Array;
  refreshArkadeScript: Uint8Array;
  serverUnrollScript: CSVMultisigTapscript.Type;
  introspectorUrl: string;
  arkProvider: ArkProvider;
}): Promise<string> {
  const {
    vtxos, vtxoScript, refreshLeafScript, refreshArkadeScript,
    serverUnrollScript, introspectorUrl, arkProvider,
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
    if (vtxos[i].prevTxBytes) {
      arkTx.updateInput(i, {
        unknown: [
          ...(arkTx.getInput(i)?.unknown ?? []),
          [{ type: 0xde, key: prevArkTxKey }, vtxos[i].prevTxBytes!],
        ],
      });
    }
  }

  return submitCovenantTx({ introspectorUrl, arkTx, checkpoints, arkProvider });
}
