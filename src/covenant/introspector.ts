import { base64 } from '@scure/base';
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
 * Full Introspector → arkd → finalize flow.
 * No private key needed — signatures come from Introspector and arkd.
 */
export async function submitCovenantTx(params: {
  introspectorUrl: string;
  arkTx: Transaction;
  checkpoints: Transaction[];
  arkProvider: ArkProvider;
}): Promise<string> {
  const { introspectorUrl, arkTx, checkpoints, arkProvider } = params;

  // 1. Submit to Introspector for signing
  const { signedArkTx, signedCheckpoints } = await submitIntrospectorTx({
    introspectorUrl,
    arkTxPsbt: arkTx.toPSBT(),
    checkpointPsbts: checkpoints.map(cp => cp.toPSBT()),
  });

  // 2. Submit to arkd for server co-signing
  const { arkTxid, signedCheckpointTxs } = await arkProvider.submitTx(
    base64.encode(signedArkTx),
    signedCheckpoints.map(cp => base64.encode(cp)),
  );

  // 3. Co-sign server checkpoints with Introspector (arkd creates new PSBTs)
  const serverCheckpointPsbts = signedCheckpointTxs.map((cp: string) => base64.decode(cp));
  const { signedCheckpoints: fullySignedCheckpoints } = await submitIntrospectorTx({
    introspectorUrl,
    arkTxPsbt: signedArkTx,
    checkpointPsbts: serverCheckpointPsbts,
  });

  // 4. Finalize
  await arkProvider.finalizeTx(arkTxid, fullySignedCheckpoints.map(cp => base64.encode(cp)));

  return arkTxid;
}
