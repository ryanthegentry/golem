/**
 * Arkade Script bytecode builders for covenant operations.
 * All functions accept only public keys — no private key parameters.
 */

/**
 * Build Arkade Script bytecode for covenant claim. Matches Fulmine PR #411's
 * enforcePayTo wire spec — uses BigInt-unified OP_GREATERTHANOREQUAL (0xa2)
 * with output/input amounts read via OP_INSPECT*, no explicit amount push
 * (was previously OP_GREATERTHANOREQUAL64 0xdf with LE64 push; removed by
 * Introspector PR #69 "Unified BigInt Arithmetic").
 *
 * 1. Verifies preimage hash (preimage provided via witness stack)
 * 2. Verifies output[currentInputIndex] pays to recipientWitnessProgram (taproot v1)
 * 3. Verifies output[currentInputIndex].value >= input[currentInputIndex].value
 *
 * The `minAmount` parameter is retained for backward compat with regtest
 * call sites but is unused — the new invariant compares output >= input,
 * which is strictly stronger than the previous fixed-threshold check.
 */
export function buildClaimArkadeScript(
  preimageHash: Uint8Array,
  recipientWitnessProgram: Uint8Array,
  _minAmount?: bigint,
): Uint8Array {
  if (preimageHash.length !== 20) throw new Error(`Expected 20-byte preimage hash, got ${preimageHash.length}`);
  if (recipientWitnessProgram.length !== 32) throw new Error(`Expected 32-byte witness program, got ${recipientWitnessProgram.length}`);

  return new Uint8Array([
    0xa9, 0x14, ...preimageHash, 0x88,                              // HASH160 <hash> EQUALVERIFY
    0xcd, 0x76, 0xd1, 0x51, 0x88,                                   // INPUTINDEX DUP INSPECTOUTPUTSCRIPTPUBKEY 1 EQUALVERIFY
    0x20, ...recipientWitnessProgram, 0x88,                          // <32-byte WP> EQUALVERIFY
    0xcf, 0xcd, 0xc9, 0xa2,                                          // INSPECTOUTPUTVALUE INPUTINDEX INSPECTINPUTVALUE GREATERTHANOREQUAL
  ]);
}

/**
 * Build Arkade Script bytecode for covenant refresh:
 * Full recursive covenant enforcing input[0].scriptPubKey == output[0].scriptPubKey.
 * Enabled by Introspector PR #63 which makes OP_INSPECTINPUTSCRIPTPUBKEY
 * trace through checkpoint wrappers to the original VTXO's scriptPubKey.
 *
 * Bytecode: 00 d1 00 ca 7b 88 87
 *   OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [wp_out, ver_out]
 *   OP_0 OP_INSPECTINPUTSCRIPTPUBKEY  → [wp_out, ver_out, wp_in, ver_in]
 *   OP_ROT                            → [wp_out, wp_in, ver_in, ver_out]
 *   OP_EQUALVERIFY                    → [wp_out, wp_in] (versions match)
 *   OP_EQUAL                          → [1/0] (witness programs match)
 */
export function buildRefreshArkadeScript(): Uint8Array {
  return new Uint8Array([
    0x00, 0xd1,   // OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [wp_out, ver_out]
    0x00, 0xca,   // OP_0 OP_INSPECTINPUTSCRIPTPUBKEY  → [wp_out, ver_out, wp_in, ver_in]
    0x7b,         // OP_ROT                            → [wp_out, wp_in, ver_in, ver_out]
    0x88,         // OP_EQUALVERIFY                    → [wp_out, wp_in]
    0x87,         // OP_EQUAL                          → [1/0]
  ]);
}
