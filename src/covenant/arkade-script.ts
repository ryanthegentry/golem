/**
 * Arkade Script bytecode builders for covenant operations.
 * All functions accept only public keys — no private key parameters.
 */

/**
 * Build Arkade Script bytecode for covenant claim:
 * 1. Verifies preimage hash (preimage provided via witness stack)
 * 2. Verifies output[0] pays to recipientWitnessProgram
 * 3. Verifies output[0] value >= minAmount
 */
export function buildClaimArkadeScript(
  preimageHash: Uint8Array,
  recipientWitnessProgram: Uint8Array,
  minAmount: bigint,
): Uint8Array {
  if (preimageHash.length !== 20) throw new Error(`Expected 20-byte preimage hash, got ${preimageHash.length}`);
  if (recipientWitnessProgram.length !== 32) throw new Error(`Expected 32-byte witness program, got ${recipientWitnessProgram.length}`);

  const amountLE = new Uint8Array(8);
  new DataView(amountLE.buffer).setBigUint64(0, minAmount, true);

  return new Uint8Array([
    0xa9, 0x14, ...preimageHash, 0x88,           // HASH160 <hash> EQUALVERIFY
    0x00, 0xd1, 0x51, 0x88,                       // 0 INSPECTOUTPUTSCRIPTPUBKEY, 1 EQUALVERIFY
    0x20, ...recipientWitnessProgram, 0x88,        // <32-byte WP> EQUALVERIFY
    0x00, 0xcf, 0x08, ...amountLE, 0xdf,          // 0 INSPECTOUTPUTVALUE, <amount> GTE64
  ]);
}

/**
 * Build Arkade Script bytecode for covenant refresh:
 * Verifies output[0] is a valid taproot output (version == 1).
 *
 * DESIGN NOTE: The ideal recursive covenant (input == output via
 * OP_INSPECTINPUTSCRIPTPUBKEY) doesn't work with Ark's checkpoint
 * architecture. buildOffchainTx wraps every input in a checkpoint tx
 * whose output has a 2-leaf taptree (serverUnroll + collaborative),
 * so the arkTx's input scriptPubKey != the VTXO's scriptPubKey.
 * The Introspector evaluates the Arkade Script against the arkTx,
 * where OP_INSPECTINPUTSCRIPTPUBKEY returns the checkpoint's WP.
 *
 * Workaround: Check output taproot version only. The output destination
 * is enforced by the agent constructing the tx to the same address.
 *
 * Full recursive covenant requires either:
 *   (a) Introspector "trace through checkpoints" support, or
 *   (b) arkd accepting custom checkpoint taptrees
 */
export function buildRefreshArkadeScript(): Uint8Array {
  return new Uint8Array([
    0x00, 0xd1,   // OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [wp, version]
    0x51, 0x88,   // OP_1 OP_EQUALVERIFY → version == 1 (taproot)
    // Stack: [wp] — 32-byte witness program is non-zero = truthy
  ]);
}
