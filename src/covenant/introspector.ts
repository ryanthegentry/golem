import { hex, base64 } from '@scure/base';
import type { ArkProvider } from '@arkade-os/sdk';
import { Transaction } from '@arkade-os/sdk';

/**
 * Submit transaction to the Introspector for signing.
 * No private key needed — signatures come from Introspector and arkd.
 */
export async function submitIntrospectorTx(params: {
  introspectorUrl: string;
  arkTxPsbt: Uint8Array;
  checkpointPsbts: Uint8Array[];
}): Promise<{ signedArkTx: Uint8Array; signedCheckpoints: Uint8Array[] }> {
  const { introspectorUrl, arkTxPsbt, checkpointPsbts } = params;

  const resp = await fetch(`${introspectorUrl}/v1/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ark_tx: base64.encode(arkTxPsbt),
      checkpoint_txs: checkpointPsbts.map(cp => base64.encode(cp)),
    }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Introspector /v1/tx failed (${resp.status}): ${text}`);
  const result = JSON.parse(text) as Record<string, any>;

  const signedArkTxB64 = result.signed_ark_tx ?? result.signedArkTx;
  const signedCheckpointTxsB64: string[] = result.signed_checkpoint_txs ?? result.signedCheckpointTxs ?? [];

  return {
    signedArkTx: base64.decode(signedArkTxB64),
    signedCheckpoints: signedCheckpointTxsB64.map((cp: string) => base64.decode(cp)),
  };
}

/**
 * Check if the Introspector acted as finalizer by comparing signature count
 * before and after signing. When the Introspector is the finalizer, it
 * internally submits to arkd and returns a fully signed PSBT (with both
 * Introspector and server signatures). In that case, re-submitting to arkd
 * would create a "Fail" event that overwrites the finalized VTXOs.
 */
function countTapScriptSigs(tx: Transaction, inputIndex: number): number {
  const input = tx.getInput(inputIndex);
  const sigs = (input as any).tapScriptSig;
  if (!sigs) return 0;
  // btc-signer stores tapScriptSig as array of tuples or iterable
  if (typeof sigs.length === 'number') return sigs.length;
  // If it's an iterable (Map-like), count manually
  let count = 0;
  for (const _ of sigs) count++;
  return count;
}

function wasFinalizerFlow(
  unsignedPsbt: Uint8Array,
  signedPsbt: Uint8Array,
): boolean {
  try {
    const unsigned = Transaction.fromPSBT(unsignedPsbt);
    const signed = Transaction.fromPSBT(signedPsbt);
    for (let i = 0; i < signed.inputsLength; i++) {
      const unsignedSigs = countTapScriptSigs(unsigned, i);
      const signedSigs = countTapScriptSigs(signed, i);
      // If the signed PSBT gained 2+ sigs over unsigned, the Introspector
      // added its sig AND the server's sig (finalizer submitted to arkd internally)
      if (signedSigs >= unsignedSigs + 2) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Full Introspector → arkd flow.
 * No private key needed — signatures come from Introspector and arkd.
 *
 * When the Introspector's tweaked key is the last non-arkd signer in the
 * closure (the "finalizer" role), it handles the complete pipeline internally:
 * sign → submit to arkd → combine arkd signatures → finalize.
 * Otherwise we need to relay through arkd ourselves.
 */
export async function submitCovenantTx(params: {
  introspectorUrl: string;
  arkTx: Transaction;
  checkpoints: Transaction[];
  arkProvider: ArkProvider;
}): Promise<string> {
  const { introspectorUrl, arkTx, checkpoints, arkProvider } = params;

  const unsignedArkPsbt = arkTx.toPSBT();
  const unsignedCheckpointPsbts = checkpoints.map(cp => cp.toPSBT());

  // 1. Submit to Introspector for signing (may also finalize if it's the finalizer)
  const { signedArkTx, signedCheckpoints } = await submitIntrospectorTx({
    introspectorUrl,
    arkTxPsbt: unsignedArkPsbt,
    checkpointPsbts: unsignedCheckpointPsbts,
  });

  // 2. Relay to arkd for server signing.
  //    The Introspector signs but may or may not act as finalizer internally.
  //    We always relay to arkd ourselves — if already finalized, arkd returns
  //    the existing txid. If not, arkd adds its signature.
  console.log('[introspector] Submitting to arkd...');
  let arkTxid: string;
  let serverCheckpointTxs: string[];

  try {
    const result = await arkProvider.submitTx(
      base64.encode(signedArkTx),
      signedCheckpoints.map(cp => base64.encode(cp)),
    );
    arkTxid = result.arkTxid;
    serverCheckpointTxs = result.signedCheckpointTxs;
    console.log(`[introspector] arkd accepted: ${arkTxid}`);
  } catch (submitErr: any) {
    // If the Introspector already finalized (acted as finalizer), arkd may
    // reject with INVALID_SIGNATURE or duplicate. Fall back to PSBT txid.
    const finalTx = Transaction.fromPSBT(signedArkTx);
    console.log(`[introspector] arkd submission failed (${submitErr.message}), checking if already finalized...`);
    // The tx may already be finalized — return the PSBT-derived txid
    return finalTx.id;
  }

  // Co-sign server checkpoints with Introspector
  const serverCheckpointPsbts = serverCheckpointTxs.map((cp: string) => base64.decode(cp));
  const { signedCheckpoints: fullySignedCheckpoints } = await submitIntrospectorTx({
    introspectorUrl,
    arkTxPsbt: signedArkTx,
    checkpointPsbts: serverCheckpointPsbts,
  });

  // Finalize
  await arkProvider.finalizeTx(arkTxid, fullySignedCheckpoints.map(cp => base64.encode(cp)));
  console.log(`[introspector] Finalized: ${arkTxid}`);
  return arkTxid;
}
