# Draft Response to Kukks — Issue #14 Comment

> **Status:** REVISED DRAFT — red-teamed, for Ryan's review before posting
> **Date:** 2026-03-08
> **Context:** Kukks asked three design questions about the OP_INSPECTINPUTVTXOWITNESSPROGRAM proposal
> **Red team:** See `KUKKS-RESPONSE-REDTEAM.md` for full analysis

---

## Proposed response:

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

**SubmitTx** uses checkpoint traversal. The ark tx's inputs reference checkpoint outputs (due to `buildOffchainTx` wrapping), so `prevOutFetcher` returns the checkpoint's scriptPubKey, not the original VTXO's. But the checkpoint PSBT's `Inputs[0].WitnessUtxo.PkScript` carries the original VTXO's scriptPubKey (set during `buildArkTx` from the original VTXO output script). The cross-reference:

```go
inputTxid := arkPtx.UnsignedTx.TxIn[inputIndex].PreviousOutPoint.Hash.String()
checkpointPtx, ok := indexedCheckpoints[inputTxid]
// checkpoint input[0] references the original VTXO
originalPkScript := checkpointPtx.Inputs[0].WitnessUtxo.PkScript
if !bytes.Equal(entry.VtxoScriptPubKey, originalPkScript) {
    return fmt.Errorf("declared VTXO scriptPubKey doesn't match checkpoint input prevout")
}
```

**SubmitIntent** is simpler. The intent proof references original VTXOs directly — no checkpoint wrapping exists at this stage (checkpoints are created later by arkd during the round). So `prevOutFetcher` already returns the original VTXO's scriptPubKey, and validation is a direct comparison:

```go
prevOut := prevoutFetcher.FetchPrevOutput(ptx.UnsignedTx.TxIn[inputIndex].PreviousOutPoint)
if !bytes.Equal(entry.VtxoScriptPubKey, prevOut.PkScript) {
    return fmt.Errorf("declared VTXO scriptPubKey doesn't match actual prevout")
}
```

### Note on multi-input consolidation

The 7-byte recursive covenant (`input[0].vtxoScriptPubKey == output[0].scriptPubKey`) is sufficient for 1:1 refresh. For N:1 consolidation, the script should verify that ALL inputs' VTXO scriptPubKeys match the output, not just input[0] — otherwise a consolidation could mix VTXOs from different taptrees (same arkade script, different collaborative leaves) and send them all to input[0]'s address.

This grows linearly (~7 bytes per additional input check) and is still compact for typical consolidation sizes. Not blocking for the initial implementation — just flagging that the consolidation script will be slightly longer than the 1:1 case.

### Naming note

Since the opcode would push version + program separately (matching `OP_INSPECTINPUTSCRIPTPUBKEY`), the name should probably end in `SCRIPTPUBKEY` rather than `WITNESSPROGRAM` — something like `OP_INSPECTINPUTVTXOSCRIPTPUBKEY`. But this is bikeshedding; happy with whatever you prefer.

---

Happy to help test once you have a branch. We can run the same regtest flow (two covenant VTXOs → consolidation with recursive covenant script) against the new opcode.
