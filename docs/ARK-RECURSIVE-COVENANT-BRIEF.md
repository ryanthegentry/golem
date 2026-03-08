# Input Introspection Through Checkpoints: A Design Question for Ark Labs

*Technical discussion document — March 2026*
*From: Golem (Bitcoin agent wallet on Ark)*

---

## 1. What We're Building and Why This Matters

Golem is a Bitcoin agent wallet on Ark. AI agents receive Lightning payments via L402 and hold funds in covenant-secured VTXOs. The target architecture separates key material from agent logic: the agent operates autonomously for receive and refresh operations using Arkade Script covenants, while the user's private key stays on their mobile device.

The Introspector is stateless — it evaluates the Arkade Script against the transaction context and co-signs if the script passes. The tweaked key (`base_key + TaggedHash("ArkScriptHash", script) * G`) binds signing authority to the specific script committed in the taptree, so the Introspector doesn't need to track which VTXOs use which covenant scripts.

We have a working prototype on regtest with a 3-leaf taptree VTXO:

| Leaf | Script | Purpose | Key Required |
|------|--------|---------|-------------|
| 0 | `MultisigTapscript([introspector_tweaked_key, server])` | Refresh via Introspector | None |
| 1 | `MultisigTapscript([alice, server])` | Collaborative spending + Ark ops | Alice (mobile) |
| 2 | `CSVMultisigTapscript({timelock, alice})` | Unilateral exit | Alice (mobile) |

The full lifecycle works on regtest: claim → refresh → consolidation (2→1 VTXO) → collaborative spend. The covenant module is ~300 lines across 6 files.

**The specific thing we want to do:** enforce that a refresh operation produces an output with the same scriptPubKey as the input — a recursive covenant. This would let the agent refresh VTXOs without any key material, with the protocol itself guaranteeing funds can't be redirected.

## 2. What We Found: Input Introspection Returns Checkpoint Data

While testing recursive covenants, we discovered that `OP_INSPECTINPUTSCRIPTPUBKEY` returns the witness program of the checkpoint transaction, not the original VTXO. We understand this is a consequence of how `buildOffchainTx` constructs the transaction graph — each VTXO input gets wrapped in a checkpoint for server forfeit and unilateral settlement — and that this structure exists for good reason.

We want to understand whether this is an intended constraint of the current design, and if so, what the right way to work within it might be.

### Regtest observations

**Observation A — What input introspection sees:**

We refreshed a covenant VTXO using a 4-byte Arkade Script that only checks output taproot version (`00d15188`). The refresh succeeded, but we logged what the introspection opcodes actually see:

```
OP_INSPECTINPUTSCRIPTPUBKEY returns: 512072156cab...  (checkpoint WP)
Original VTXO scriptPubKey:          5120c737670e...  (VTXO WP)
These do not match.
```

The 4-byte script passes because it doesn't inspect the input — it only verifies the output is taproot.

**Observation B — Recursive covenant attempt:**

We then tested a 7-byte script implementing `input[0].scriptPubKey == output[0].scriptPubKey`:

```
00d100ca7b8887
OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_0 OP_INSPECTINPUTSCRIPTPUBKEY OP_ROT OP_EQUALVERIFY OP_EQUAL
```

This failed because the input scriptPubKey (checkpoint) doesn't match the output scriptPubKey (VTXO). The Introspector evaluated the script correctly but returned error code 13 (script evaluation failure) — the `OP_EQUAL` comparison returned false.

**Observation C — Checkpoints are mandatory:**

Submitting transactions with empty `checkpoint_txs` is rejected by both the Introspector and arkd with error code 3 ("missing checkpoint txs"). There's no way to bypass the wrapping.

### What we're uncertain about

We don't have full visibility into the checkpoint construction logic in `buildOffchainTx`, the Introspector's evaluation model, or how tightly coupled these are. Several questions follow from that:

1. **Was input introspection through checkpoints considered during opcode design?** It's possible this is a known limitation with a planned resolution, or that recursive covenants on VTXOs were never an intended use case.

2. **Is the checkpoint structure stable?** If it changes (additional leaves, different key derivation), any solution that assumes a specific checkpoint format would break.

3. **Are there constraints we're not seeing?** The checkpoint serves server forfeit and unilateral settlement. Modifying it to preserve the VTXO's script identity might have implications for those paths that aren't obvious from the outside.

## 3. What We're Currently Doing (and Its Weakness)

Our working refresh uses a 4-byte Arkade Script:

```
00 d1 51 88
OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [wp, ver]
OP_1 OP_EQUALVERIFY               → ver == 1 (taproot)
                                     stack: [wp] (truthy, any 32-byte value)
```

This passes for any taproot output. The agent process constructs the transaction to the same address, but the script doesn't enforce this. A compromised agent could redirect to a different taproot address and both the Introspector and arkd would co-sign it.

**We're honest about the threat model here:** this requires compromising the agent process (not extracting a key — there is no key), constructing a valid offchain tx with a different output, and racing the VTXO owner who can spend via Leaf 1 at any time. It's dramatically better than a hot key on a server. But the recursive covenant would eliminate the agent-integrity dependency entirely — the protocol enforces same-address output, full stop.

**Why not just have the mobile device approve each refresh?** Because the VTXO expiry on Arkade mainnet is 7 days. Weekly phone interaction for every user is a meaningfully worse UX than "set it and forget it." For L402 API providers running always-on gateways, requiring manual refresh approval defeats the purpose of autonomous operation. The covenant makes the agent trustworthy by construction, not by monitoring.

## 4. Possible Approaches (We Defer to Your Judgment)

We've thought about several directions, but we don't have enough visibility into Ark's internals to know which is viable or whether there's a simpler path we're missing.

### Direction A: Opcode that resolves through checkpoints

A new opcode (e.g., `OP_INSPECTORIGINALSCRIPTPUBKEY`) that returns the original VTXO's witness program by resolving through the checkpoint wrapper. The existing `OP_INSPECTINPUTSCRIPTPUBKEY` keeps its current literal semantics.

*What we like:* Clean separation — script authors explicitly choose checkpoint-resolved vs. literal behavior.

*What concerns us:* This couples the script VM to the checkpoint structure. If the checkpoint format evolves, the resolution logic must update. This might be a layering violation you'd want to avoid.

### Direction B: Transaction builder carries original WP in the Introspector Packet

Extend the OP_RETURN TLV packet (magic `0x41524b`) with a new record type carrying the original VTXO's witness program per input. The Introspector already parses these packets.

*What we like:* Uses the existing extension mechanism. No checkpoint coupling.

*What concerns us:* Trust. The transaction builder declares the original WP. A malicious builder could lie. Verification would require the Introspector to check the declaration against the checkpoint chain — re-introducing the coupling this approach tries to avoid. That said, this trust assumption is equivalent to the 4-byte workaround's: the builder already controls output construction today. This wouldn't make things worse, it would just fail to make them better if the builder is compromised.

### Direction C: Checkpoint preserves VTXO script identity

Modify checkpoint construction so the checkpoint's witness program matches or contains the VTXO's. For example, include the VTXO script as an additional checkpoint leaf, or tweak the checkpoint key with the VTXO's script hash.

*What we like:* Fixes at the source. `OP_INSPECTINPUTSCRIPTPUBKEY` returns the right value naturally.

*What concerns us:* This modifies Ark's core transaction construction. We don't understand enough about how checkpoint structure interacts with server forfeit paths, the connector tree, and unilateral settlement to evaluate the risk. This is your call entirely.

### Direction D: Something we haven't considered

We may be approaching this wrong. If there's an existing mechanism, a planned feature, or a different architectural pattern that achieves "agent can refresh without key material, protocol enforces same-address output," we'd love to hear it.

## 5. Applications Beyond Our Use Case

We think this matters for more than just Golem, though we're obviously biased:

- **Any autonomous agent managing VTXOs** needs refresh without key material. The 7-day expiry makes this operationally critical.
- **Merchant receive-only addresses** where funds should only move to a predefined cold storage destination.
- **Treasury policies** like "consolidate VTXOs to same script" — useful for any organization holding funds on Ark.
- **General recursive covenants** — the `input == output` primitive is foundational. Enabling it on Ark opens a design space that currently only exists on Liquid (and there, without the off-chain scaling).

## 6. What We Can Contribute

We'll implement and test whatever solution you think is right on regtest and submit a PR. Our covenant module and test infrastructure are ready.

We'd need:
- **For any opcode changes:** A pointer to the Introspector's opcode evaluation codebase.
- **For packet extensions:** Guidance on the TLV record format and Introspector parsing.
- **For checkpoint changes:** Guidance on `buildOffchainTx` internals from your team.

Or, if the right answer is "this isn't the right approach and here's why," we want to hear that too. We'd rather build on a solid foundation than push a solution that doesn't fit Ark's architecture.

---

## Appendix: Regtest Evidence

### A. Experiment Output

```
╔══════════════════════════════════════════════════════════════════╗
║  CHECKPOINT EXPERIMENT — Evidence for Ark Labs Discussion       ║
╚══════════════════════════════════════════════════════════════════╝

arkd: regtest, Introspector: v0.0.1

=== OBSERVATION A: What Input Introspection Sees ===

4-byte refresh Arkade Script: 00d15188
VTXO pkScript (34 bytes): 5120c737670e692a76256309b9460410e78a54125cdc6d2eff94c0c5eb69c74e7b92

Checkpoint count: 1
Checkpoint taptree: 2-leaf (serverUnroll + collaborative)

Input scriptPubKey (what OP_INSPECTINPUTSCRIPTPUBKEY returns):
  512072156cab4c2f76f1d59d0c5ba549da3a13cef2db1c15f7c68938713338f95001

Original VTXO pkScript:
  5120c737670e692a76256309b9460410e78a54125cdc6d2eff94c0c5eb69c74e7b92

Match: NO
4-byte refresh result: SUCCESS (txid: 0f23f418...)

=== OBSERVATION B: Recursive Covenant Attempt ===

7-byte Arkade Script: 00d100ca7b8887
  OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_0 OP_INSPECTINPUTSCRIPTPUBKEY
  OP_ROT OP_EQUALVERIFY OP_EQUAL

Input scriptPubKey (checkpoint):  512093cfd84e...
Output scriptPubKey (VTXO):       512028b1dee1...
Match: NO

7-byte refresh result: FAILED
Error: Introspector /v1/tx failed (500): {"code":13, "message":"failed to process transaction"}

=== OBSERVATION C: Checkpoints Are Mandatory ===

Introspector with empty checkpoint_txs: REJECTED
  Error: {"code":3, "message":"missing checkpoint txs"}

arkd with empty checkpoints: REJECTED
  Error: {"code":3, "message":"missing checkpoint txs"}
```

### B. VTXO Taptree Structure

```
                    ┌─────────────────┐
                    │  Taproot Output  │
                    │   (VTXO key)     │
                    └────────┬────────┘
                             │
                    ┌────────┼────────┐
                    │                 │
              ┌─────┴─────┐    ┌─────┴─────┐
              │  Branch    │    │  Leaf 2   │
              └─────┬─────┘    │  Unilat.  │
                    │          │  (exit)   │
              ┌─────┴─────┐   └───────────┘
              │           │
         ┌────┴────┐ ┌───┴────┐
         │ Leaf 0  │ │ Leaf 1 │
         │Covenant │ │Collab. │
         │(refresh)│ │(A+Op)  │
         └─────────┘ └────────┘
```

### C. Refresh Scripts

**4-byte workaround** (current):

```typescript
export function buildRefreshArkadeScript(): Uint8Array {
  return new Uint8Array([
    0x00, 0xd1,   // OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [wp, version]
    0x51, 0x88,   // OP_1 OP_EQUALVERIFY → version == 1 (taproot)
    // Stack: [wp] — 32-byte witness program is non-zero = truthy
  ]);
}
```

**7-byte recursive covenant** (target):

```typescript
function buildRecursiveRefreshArkadeScript(): Uint8Array {
  return new Uint8Array([
    0x00, 0xd1,   // OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [out_wp, out_ver]
    0x00, 0xca,   // OP_0 OP_INSPECTINPUTSCRIPTPUBKEY  → [out_wp, out_ver, in_wp, in_ver]
    0x7b,         // OP_ROT → [out_wp, in_wp, in_ver, out_ver]
    0x88,         // OP_EQUALVERIFY → in_ver == out_ver? → [out_wp, in_wp]
    0x87,         // OP_EQUAL → out_wp == in_wp? → [true/false]
  ]);
}
```
