# Red Team: KUKKS-RESPONSE-DRAFT.md

*Analysis date: March 8, 2026*
*Scope: Red team review of draft response to Kukks' three design questions (Issue #14)*

---

## Verdict

The draft is **technically sound on its surface** and the three recommendations (0xd0 slot, version+program push, hard reject) are correct. But it has two material gaps that should be addressed before posting, and one claim that needs correction. A revised draft follows.

---

## What's Strong

1. **`pushScriptPubKey` reuse.** Verified against source (`opcode.go:2080`). The helper correctly handles segwit v0, v1, and non-witness scripts. Calling `pushScriptPubKey(entry.VtxoScriptPubKey, vm)` produces identical stack format to `OP_INSPECTOUTPUTSCRIPTPUBKEY`. The draft's handler code is copy-pasteable.

2. **Hard-reject argument.** All three reasons hold up. `readArkadeScript()` does hard validation (computes `ArkadeScriptHash`, derives tweaked key, rejects mismatch). Following the same pattern for the VTXO scriptPubKey record is consistent. The Introspector's signature should mean "I have verified everything."

3. **7-byte script stack operations.** Verified the stack trace manually. `OP_ROT` correctly moves `out_ver` to top for the `EQUALVERIFY`, leaving `[out_wp, in_wp]` for the final `EQUAL`. The script works.

4. **Naming suggestion.** Correct. If it pushes version + program (matching `pushScriptPubKey`), naming it `...SCRIPTPUBKEY` is consistent.

---

## Critical Issues

### 1. The SubmitIntent claim is backwards — it's the EASY case, not the hard one

The draft says:

> "One consideration: the SubmitIntent path doesn't have separate checkpoint PSBTs, so validation there would need to use whatever prevout data the intent PSBT carries."

This implies SubmitIntent is harder. **It's actually the opposite.** Code analysis reveals:

- **SubmitTx:** The ark tx's inputs reference checkpoint outputs. `prevOutFetcher` returns the checkpoint's scriptPubKey (the 2-leaf wrapper). Validation requires traversing `indexedCheckpoints` → `checkpointPtx.Inputs[0].WitnessUtxo.PkScript` to reach the original VTXO. This is the HARD case.

- **SubmitIntent:** The intent proof is a BIP-322 proof-of-ownership. Its inputs reference the **original VTXOs directly** — no checkpoint wrapping exists yet (checkpoints are created later by arkd during the round). `prevOutFetcher` returns the original VTXO's scriptPubKey. Validation is a simple `bytes.Equal(entry.VtxoScriptPubKey, prevOut.PkScript)`. This is the EASY case.

**Impact:** The draft's hand-wave creates unnecessary concern. It should instead state that SubmitIntent validation is straightforward (direct prevout comparison), while SubmitTx requires checkpoint traversal. Both paths are feasible.

### 2. The validation code snippet oversimplifies checkpoint traversal

The draft's code (lines 66-74) suggests:

```go
inputTxid := arkPtx.UnsignedTx.TxIn[inputIndex].PreviousOutPoint.Hash.String()
checkpointPtx, ok := indexedCheckpoints[inputTxid]
originalPkScript := checkpointPtx.Inputs[0].WitnessUtxo.PkScript
```

This is **correct for SubmitTx** (verified: `buildArkTx` sets `WitnessUtxo` from the original VTXO's output script at `offchain/tx.go:97-107`). But presenting it without explaining WHY this works (and that it only works in SubmitTx) leaves Kukks to figure out the SubmitIntent path himself.

**Recommendation:** Explicitly state that SubmitTx and SubmitIntent need different validation strategies, and that SubmitIntent is the simpler one.

---

## Important Issues

### 3. Multi-input consolidation: the recursive covenant only checks input[0]

The 7-byte recursive covenant checks `input[0].vtxoScriptPubKey == output[0].scriptPubKey`. For N:1 consolidation, this means:

- Input[0]'s VTXO address determines the output address ✓
- Inputs [1..N-1] are NOT checked against the output ✗

The cross-input `OP_INSPECTINPUTARKADESCRIPTHASH` (from PR #15) verifies all inputs share the same arkade script, but same arkade script ≠ same VTXO address. Two VTXOs can share the refresh script (`00d15188`) but have different `alice_pubkey` values in their collaborative leaf, producing different taptree roots and different addresses.

**Is this exploitable?** Only if an attacker compromises the agent process AND constructs a consolidation tx where their VTXO is input[0]. Then the victim's VTXOs (inputs 1..N) get consolidated to the attacker's address. This is within the existing threat model (agent compromise = redirect risk), but the recursive covenant was supposed to CLOSE this gap.

**Fix:** The consolidation arkade script should check ALL inputs' VTXO scriptPubKeys match the output, not just input[0]. Something like:

```
// For each input index i:
<i> OP_INSPECTINPUTVTXOSCRIPTPUBKEY
OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY
OP_ROT OP_EQUALVERIFY OP_EQUALVERIFY
```

This grows linearly with input count. For a fixed consolidation max (e.g., 10 inputs), it's ~70 bytes — still well within limits. Alternatively, combine with `OP_INSPECTINPUTARKADESCRIPTHASH` uniformity check + input[0] recursive check if all VTXOs belonging to the same user are guaranteed to have the same taptree.

**Recommendation:** Flag this in the response. Kukks should know the consolidation use case needs thought beyond the 7-byte script.

### 4. TOCTOU between Introspector validation and arkd checkpoint reconstruction

The flow (from HYBRID-CLAIMS.md Phase 4) is:

1. Agent builds offchain tx with OP_RETURN TLV
2. Introspector validates TLV records + signs
3. arkd's `submitTx` creates its **own** checkpoint PSBTs
4. Introspector must re-sign the new checkpoints

Between step 2 and step 4, arkd creates new checkpoints. Does the Introspector re-validate the TLV records at step 4? If not, could arkd's checkpoint construction invalidate the TLV data that was validated at step 2?

In practice, the TLV records are about the ark tx inputs (which don't change between steps 2-4), so this is likely a non-issue. But it's worth confirming that the checkpoint re-signing step doesn't bypass TLV validation.

### 5. `readArkadeScript` only parses `MultisigClosure` (utils.go:49)

There's a `TODO: allow any type of closure (condition, cltv ...)` in the source. The Introspector currently skips any tapscript leaf that isn't a plain `MultisigClosure`. This means:

- Covenant VTXOs with `CLTVMultisigClosure` or `ConditionMultisigClosure` leaves won't be recognized
- Currently not blocking (all covenant leaves use plain `MultisigClosure`), but future features could hit this

Not a problem for the draft response specifically, but worth noting for overall architecture awareness.

---

## Minor Issues

### 6. Opcode proliferation vs. general-purpose TLV read

The draft proposes a single-purpose opcode for one specific TLV record type. An alternative: a general-purpose `OP_INSPECTINPUTINTROSPECTORRECORD` that takes an index AND a record type, returning the raw bytes. This would handle future TLV record types without new opcodes.

**Counter-argument:** Single-purpose opcodes are simpler, safer, and match existing patterns. The Introspector already has ~45 opcodes. One more is fine. Premature generalization would add complexity without clear benefit.

**Recommendation:** Not worth raising in the response. The single-purpose approach is correct for now.

### 7. Non-taproot VTXO edge case

`pushScriptPubKey` handles non-taproot inputs by pushing `SHA256(scriptPubKey)` + version `-1`. If a non-taproot VTXO enters the system, the recursive covenant comparison would fail (version mismatch: `-1` vs `1`). This is actually correct behavior — the covenant should reject non-taproot outputs. Not a bug.

### 8. Backward compatibility

Scripts using the new opcode will fail on older Introspector versions. The Introspector is deployed alongside arkd, so versioning is controlled. Not a concern for the response.

---

## What Needs Testing Before You're Clear on Implications

1. **SubmitIntent prevOutFetcher contents.** Verify that `intent.New()` (in `ark-lib/intent/proof.go`) sets `WitnessUtxo.PkScript` to the original VTXO's scriptPubKey, not a checkpoint wrapper. High confidence this is correct (intents don't involve checkpoints), but should be confirmed.

2. **Multi-input consolidation with recursive covenant.** Write a test: two VTXOs with same arkade script but DIFFERENT `alice_pubkey` → consolidation via covenant leaf → does it succeed? If yes, confirm funds go to input[0]'s address. This validates whether the multi-input gap is exploitable.

3. **Checkpoint re-signing TLV re-validation.** Trace the checkpoint re-signing flow in `SubmitTx` after arkd creates new checkpoints. Does the Introspector re-run `readArkadeScript` and re-validate TLV records, or does it just sign blindly?

4. **`OP_INSPECTINPUTSCRIPTPUBKEY` in SubmitIntent.** If the intent proof's prevOutFetcher has the original VTXO scriptPubKey, then `OP_INSPECTINPUTSCRIPTPUBKEY` (0xca) would return the original VTXO's scriptPubKey in the intent path — meaning the recursive covenant (`input == output`) would work WITHOUT the new opcode in the intent path! This would mean the new opcode is only needed for the SubmitTx path. Worth verifying.

---

## Recommendations

### A. Revise the response before posting

The three recommendations (slot, format, hard reject) are correct. But:

1. **Fix the SubmitIntent narrative.** Don't hand-wave it as "potentially different lookup path." State clearly: SubmitIntent is the easy case (direct prevout comparison, no checkpoint traversal). SubmitTx requires checkpoint traversal (code snippet provided).

2. **Flag the consolidation multi-input gap.** Mention that the 7-byte script covers 1:1 refresh but consolidation needs additional thought (all inputs vs. just input[0]).

3. **Tighten the validation code.** Show both paths explicitly (SubmitTx with checkpoint traversal, SubmitIntent with direct comparison), not just the SubmitTx path with a vague note about SubmitIntent.

### B. Run the tests from "What Needs Testing" before or after posting

Items 1-4 above can be tested on regtest. They don't BLOCK the response (the response is about design direction, not implementation), but they'd strengthen the conversation and catch surprises early.

### C. Consider raising the consolidation question proactively

The biggest second-order effect is the multi-input consolidation gap. If Kukks implements the opcode and you later discover that consolidation requires a different script pattern, that's a wasted iteration. Better to flag it now: "For 1:1 refresh, the 7-byte recursive covenant is sufficient. For N:1 consolidation, we'll need to verify all inputs' VTXO scriptPubKeys match the output — this grows linearly but is still compact."

---

## Revised Draft

Below is the revised response incorporating all findings. Changes from original are marked with `[CHANGED]` comments.

---

Thanks @Kukks, and thanks for the fast turnaround on the `SetIntrospectorPacket` fix in `24947ea`.

### Opcode slot

No strong preference. **`0xd0`** seems like the natural choice — it's the only unused slot in the contiguous introspection block (`0xc7`–`0xd6`), so filling it avoids a gap. The semantic grouping is slightly off (it sits between the output introspection opcodes `0xcf`/`0xd1`), but the opcode name makes the purpose clear regardless of position.

If you'd prefer to reserve `0xd0` for a future output-related opcode, the `0xbb`–`0xc3` range has 9 consecutive open slots — any of those would work.

Deferring to you on this one.

### Push format: version + program separately

**Matching the `OP_INSPECTOUTPUTSCRIPTPUBKEY` / `OP_INSPECTINPUTSCRIPTPUBKEY` pattern (push version and program as separate stack items) is the right call.** This is what makes the comparison work:

```
OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY       → stack: [out_wp, out_ver]
OP_0 <new_opcode>                        → stack: [out_wp, out_ver, in_wp, in_ver]
OP_ROT                                   → stack: [out_wp, in_wp, in_ver, out_ver]
OP_EQUALVERIFY                           → checks in_ver == out_ver → [out_wp, in_wp]
OP_EQUAL                                 → checks out_wp == in_wp → [true/false]
```

The handler can reuse the existing `pushScriptPubKey` helper (`pkg/arkade/opcode.go:2080`), which already handles witness program extraction and version parsing for both segwit v0/v1 and non-witness scripts. Something like:

```go
func opcodeInspectInputVtxoScriptPubKey(op *opcode, data []byte, vm *Engine) error {
    index, err := vm.dstack.PopInt()
    if err != nil { return err }

    if vm.introspectorPacket == nil {
        return scriptError(txscript.ErrInvalidStackOperation, "no introspector packet")
    }

    entry, found := vm.introspectorPacket.FindEntryByVin(uint16(index))
    if !found {
        return scriptError(txscript.ErrInvalidStackOperation,
            fmt.Sprintf("no introspector entry for vin %d", index))
    }

    return pushScriptPubKey(entry.VtxoScriptPubKey, vm)
}
```

For the TLV record, I'd suggest storing the raw `scriptPubKey` bytes (e.g., `5120{32-byte-wp}` for taproot = 34 bytes). This way the opcode parses it through the same `pushScriptPubKey` path that all the other scriptPubKey introspection opcodes use.

### TLV record validation: hard reject

**The Introspector should reject packets where the declared scriptPubKey doesn't match the actual prevout.** Three reasons:

**1. Matches the existing validation pattern.** `readArkadeScript()` in `utils.go` already does hard validation: it computes `ArkadeScriptHash(entry.Script)`, derives the expected tweaked public key, and rejects if it doesn't match the tapscript. The VTXO scriptPubKey should follow the same pattern — the Introspector's signature means "I have verified all declared data against the actual transaction state."

**2. Prevents builder fraud.** If the field were soft, a malicious transaction builder could declare any scriptPubKey, and scripts using the new opcode would receive false data. The whole purpose of this opcode is to provide trustworthy access to the original VTXO identity — that trust requires validation.

**3. The validation path exists for both code paths, with different strategies:**

`[CHANGED]` **SubmitTx** uses checkpoint traversal. The ark tx's inputs reference checkpoint outputs (due to `buildOffchainTx` wrapping), so `prevOutFetcher` returns the checkpoint's scriptPubKey, not the original VTXO's. But the checkpoint PSBT's `Inputs[0].WitnessUtxo.PkScript` carries the original VTXO's scriptPubKey (set during `buildArkTx` from the original VTXO output script). The cross-reference:

```go
inputTxid := arkPtx.UnsignedTx.TxIn[inputIndex].PreviousOutPoint.Hash.String()
checkpointPtx, ok := indexedCheckpoints[inputTxid]
// checkpoint input[0] references the original VTXO
originalPkScript := checkpointPtx.Inputs[0].WitnessUtxo.PkScript
if !bytes.Equal(entry.VtxoScriptPubKey, originalPkScript) {
    return fmt.Errorf("declared VTXO scriptPubKey doesn't match checkpoint input prevout")
}
```

`[CHANGED]` **SubmitIntent** is simpler. The intent proof references original VTXOs directly — no checkpoint wrapping exists at this stage (checkpoints are created later by arkd during the round). So `prevOutFetcher` already returns the original VTXO's scriptPubKey, and validation is a direct comparison:

```go
prevOut := prevoutFetcher.FetchPrevOutput(ptx.UnsignedTx.TxIn[inputIndex].PreviousOutPoint)
if !bytes.Equal(entry.VtxoScriptPubKey, prevOut.PkScript) {
    return fmt.Errorf("declared VTXO scriptPubKey doesn't match actual prevout")
}
```

### `[ADDED]` Note on multi-input consolidation

The 7-byte recursive covenant (`input[0].vtxoScriptPubKey == output[0].scriptPubKey`) is sufficient for 1:1 refresh. For N:1 consolidation, the script should verify that ALL inputs' VTXO scriptPubKeys match the output, not just input[0]. Otherwise, a consolidation could mix VTXOs from different taptrees (same arkade script, different collaborative leaves) and send them all to input[0]'s address.

This grows linearly (~7 bytes per additional input check) and is still compact for typical consolidation sizes. For the initial implementation, the 1:1 case is what matters — just flagging that the consolidation script will need to be slightly longer.

### Naming note

Since the opcode would push version + program separately (matching `OP_INSPECTINPUTSCRIPTPUBKEY`), the name should probably end in `SCRIPTPUBKEY` rather than `WITNESSPROGRAM` — something like `OP_INSPECTINPUTVTXOSCRIPTPUBKEY`. But this is bikeshedding; happy with whatever you prefer.

---

Happy to help test once you have a branch. We can run the same regtest flow (two covenant VTXOs → consolidation with recursive covenant script) against the new opcode.
