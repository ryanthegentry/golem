# Recursive Covenants on Ark: Checkpoint Wrapping Limitation

*Technical brief for Ark Labs — March 2026*
*From: Golem (Bitcoin agent wallet on Ark)*

---

## 1. Problem Statement

Recursive covenants on Ark — where an Arkade Script enforces `input[0].scriptPubKey == output[0].scriptPubKey` — are broken by checkpoint wrapping. `buildOffchainTx` wraps every VTXO input in a 2-leaf checkpoint transaction before the Introspector evaluates the Arkade Script. `OP_INSPECTINPUTSCRIPTPUBKEY` returns the **checkpoint's** witness program, not the **original VTXO's**. This makes the fundamental covenant primitive `input == output` impossible on Ark today. The limitation is architectural — neither the Introspector nor arkd is individually at fault.

## 2. Background: What We're Building

Golem is a Bitcoin agent wallet on Ark. AI agents receive Lightning payments via L402 and hold funds in covenant-secured VTXOs. The agent operates with **zero private key material** — claims use `preimage + Introspector`, refresh uses `covenant + Introspector`. The user's private key stays on their mobile device and never touches the server.

The covenant VTXO is a 3-leaf taptree:

| Leaf | Script | Purpose | Key Required |
|------|--------|---------|-------------|
| 0 | `MultisigTapscript([introspector_tweaked_key, server])` | Refresh via Introspector | None |
| 1 | `MultisigTapscript([alice, server])` | Collaborative spending + Ark ops | Alice (mobile) |
| 2 | `CSVMultisigTapscript({timelock, alice})` | Unilateral exit | Alice (mobile) |

The full lifecycle is validated on regtest: claim -> refresh -> consolidation (2->1 VTXO) -> collaborative spend. The covenant module is ~300 lines across 6 files (`src/covenant/`).

## 3. The Limitation

### What happens during refresh

When the agent refreshes a VTXO via Leaf 0:

1. `buildOffchainTx` creates **one checkpoint per input**. Each checkpoint wraps the VTXO in a new 2-leaf taptree (`serverUnroll + collaborative`).
2. The `arkTx` input references the **checkpoint output**, not the original VTXO.
3. The Introspector evaluates the Arkade Script against the `arkTx`. `OP_INSPECTINPUTSCRIPTPUBKEY` returns the checkpoint output's scriptPubKey.

### Regtest evidence

**Experiment A — Checkpoint wrapping behavior (4-byte refresh):**

```
Input scriptPubKey (what OP_INSPECTINPUTSCRIPTPUBKEY sees):
  512072156cab4c2f76f1d59d0c5ba549da3a13cef2db1c15f7c68938713338f95001

VTXO pkScript (what we want the opcode to see):
  5120c737670e692a76256309b9460410e78a54125cdc6d2eff94c0c5eb69c74e7b92

Match: NO
Checkpoint count: 1
Checkpoint taptree: 2-leaf (serverUnroll + collaborative)
4-byte refresh result: SUCCESS (txid: 0f23f418f2a0866548391ad6d8a20d206e79338a5be8fe21833a76d6440ad239)
```

The 4-byte refresh script (`00d15188`) succeeds because it only checks output taproot version, not the input's scriptPubKey.

**Experiment B — 7-byte recursive covenant (input == output):**

```
7-byte recursive Arkade Script: 00d100ca7b8887
  OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_0 OP_INSPECTINPUTSCRIPTPUBKEY OP_ROT OP_EQUALVERIFY OP_EQUAL

Input scriptPubKey (checkpoint WP):
  512093cfd84e34d7d5725d6aa432ed361991d6b115a5b00b564c78b1e1c344f7f532

Output scriptPubKey (VTXO WP):
  512028b1dee12f0422665dea2537be51893d53e7574364f11723e6a9b1c84572babd

Match: NO
7-byte refresh result: FAILED
Error: Introspector /v1/tx failed (500): {"code":13, "message":"failed to process transaction"}
```

The 7-byte script correctly implements `input[0].scriptPubKey == output[0].scriptPubKey`. It fails because `OP_INSPECTINPUTSCRIPTPUBKEY` returns `93cfd8...` (checkpoint) instead of `28b1de...` (VTXO).

**Experiment C — Empty checkpoints:**

```
Introspector with empty checkpoint_txs: REJECTED
  Error: {"code":3, "message":"missing checkpoint txs"}

arkd with empty checkpoints: REJECTED
  Error: {"code":3, "message":"missing checkpoint txs"}
```

Both enforce checkpoints — there is no bypass.

### The 4-byte workaround and its limitation

Our current refresh Arkade Script:

```
00 d1 51 88    (4 bytes)
OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [wp, ver]
OP_1 OP_EQUALVERIFY               → ver == 1 (taproot)
                                     stack: [wp] (truthy)
```

This passes for **any** taproot output address. The agent process constructs the refresh transaction to the same address, but a compromised agent could redirect to a different taproot address. Both the Introspector and arkd would co-sign it. This creates an agent-integrity dependency that the recursive covenant would eliminate.

## 4. Impact Beyond Golem

This limitation affects every application using `OP_INSPECTINPUTSCRIPTPUBKEY` on Ark:

- **Keyless agent wallets** (our use case): Can't enforce refresh-to-same-address without trusting the agent process
- **Merchant receive-only addresses**: Can't build "funds can only move to my cold storage" covenants
- **Automated treasury management**: Can't enforce "consolidate to same script" policies
- **Any recursive covenant**: The primitive `input == output` is broken by checkpoint wrapping

The Introspector and Arkade Script VM support a powerful set of introspection opcodes. Checkpoint wrapping means `OP_INSPECTINPUTSCRIPTPUBKEY` returns unexpected values in the most common use case (spending a VTXO). This limits input introspection to applications that don't care about the input's original script.

## 5. Proposed Solutions

### Proposal A: New opcode `OP_INSPECTORIGINALSCRIPTPUBKEY`

A new Arkade Script opcode that resolves through the checkpoint wrapper to return the original VTXO's scriptPubKey. The existing `OP_INSPECTINPUTSCRIPTPUBKEY` keeps its current literal semantics.

| | |
|---|---|
| **Pros** | No behavior change to existing opcodes. Script authors explicitly choose checkpoint-resolved vs literal. Clean semantic distinction. |
| **Cons** | Introspector must understand checkpoint structure (coupling). If checkpoint format changes, unwrapping logic must update. |

### Proposal B: Introspector Packet extension — carry original VTXO witness program

Extend the OP_RETURN Introspector Packet (TLV format, magic `0x41524b`) with a new TLV record type (e.g., `0x02`) that carries the original VTXO's witness program for each input. The Introspector already parses these packets. Current record type `0x01` carries Arkade Script entries. A new record type could carry input VTXO metadata.

| | |
|---|---|
| **Pros** | Uses existing TLV extension mechanism. No checkpoint coupling — the transaction builder declares the original WP. Easily auditable. |
| **Cons** | Trust question: who provides the original WP? A malicious builder could declare a wrong WP. Verification re-introduces some checkpoint awareness. Slightly larger OP_RETURN. |

### Proposal C: `buildOffchainTx` preserves VTXO script in checkpoint

Modify checkpoint construction so that the checkpoint's witness program matches the VTXO's. For example, include the VTXO script as an additional checkpoint leaf, or tweak the checkpoint key with the VTXO's script hash.

| | |
|---|---|
| **Pros** | Fixes at the source. `OP_INSPECTINPUTSCRIPTPUBKEY` returns the correct value naturally. Simplest mental model. |
| **Cons** | Modifies Ark's core transaction construction — highest risk. Checkpoint structure serves multiple purposes (server forfeit, unilateral settlement). May break existing arkd settlement logic. |

## 6. Our Recommendation

We recommend **Proposal A** (new opcode) as the cleanest solution, with **Proposal B** (packet extension) as a pragmatic alternative if adding a new opcode is too heavy.

Proposal C touches Ark's core transaction construction and carries the highest risk. We defer to your judgment on whether it's viable, but A or B achieve the same goal with less risk to existing infrastructure.

## 7. Our Offer

We will implement and test the chosen solution on regtest and submit a PR. Our covenant module and test infrastructure are ready. Specifically:

- **Proposal A**: We'll implement the opcode handler in our test harness and validate the 7-byte recursive covenant works end-to-end. We need a pointer to the Introspector's opcode evaluation codebase to submit the actual PR.
- **Proposal B**: We'll extend `buildOpReturnScript()` to include the new TLV record and validate the Introspector reads it correctly. Same — need a pointer to the Introspector codebase.
- **Proposal C**: We'll need guidance on `buildOffchainTx` internals from your team.

---

## Appendix: Evidence

### A. Full Experiment Output

```
╔══════════════════════════════════════════════════════════════════╗
║  CHECKPOINT EXPERIMENT — Evidence for Ark Labs Technical Brief  ║
╚══════════════════════════════════════════════════════════════════╝

arkd: regtest, Introspector: v0.0.1

=== EXPERIMENT A: Checkpoint Wrapping Behavior ===

4-byte refresh Arkade Script: 00d15188
VTXO pkScript (34 bytes): 5120c737670e692a76256309b9460410e78a54125cdc6d2eff94c0c5eb69c74e7b92
VTXO witness program (32 bytes): c737670e692a76256309b9460410e78a54125cdc6d2eff94c0c5eb69c74e7b92

Checkpoint count: 1
Checkpoint taptree: 2-leaf (serverUnroll + collaborative)

Input scriptPubKey (what OP_INSPECTINPUTSCRIPTPUBKEY sees):
  512072156cab4c2f76f1d59d0c5ba549da3a13cef2db1c15f7c68938713338f95001
  → Checkpoint output WP: 72156cab4c2f76f1d59d0c5ba549da3a13cef2db1c15f7c68938713338f95001

VTXO pkScript (what we want the opcode to see):
  5120c737670e692a76256309b9460410e78a54125cdc6d2eff94c0c5eb69c74e7b92
  → VTXO WP: c737670e692a76256309b9460410e78a54125cdc6d2eff94c0c5eb69c74e7b92

Match: NO
4-byte refresh result: SUCCESS (txid: 0f23f418f2a0866548391ad6d8a20d206e79338a5be8fe21833a76d6440ad239)

=== EXPERIMENT B: 7-byte Recursive Covenant Attempt ===

7-byte recursive Arkade Script: 00d100ca7b8887
  Opcodes: OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_0 OP_INSPECTINPUTSCRIPTPUBKEY OP_ROT OP_EQUALVERIFY OP_EQUAL
  Semantics: output[0].scriptPubKey == input[0].scriptPubKey

7-byte VTXO pkScript: 512028b1dee12f0422665dea2537be51893d53e7574364f11723e6a9b1c84572babd
7-byte VTXO WP: 28b1dee12f0422665dea2537be51893d53e7574364f11723e6a9b1c84572babd

Input scriptPubKey (checkpoint WP):
  512093cfd84e34d7d5725d6aa432ed361991d6b115a5b00b564c78b1e1c344f7f532
Output scriptPubKey (VTXO WP):
  512028b1dee12f0422665dea2537be51893d53e7574364f11723e6a9b1c84572babd
Match: NO

7-byte refresh result: FAILED
Error: Introspector /v1/tx failed (500): {"code":13, "message":"failed to process transaction"}

Root cause: OP_INSPECTINPUTSCRIPTPUBKEY returns the checkpoint's witness program
  (93cfd84e34d7d5725d6aa432ed361991d6b115a5b00b564c78b1e1c344f7f532),
  not the original VTXO's witness program
  (28b1dee12f0422665dea2537be51893d53e7574364f11723e6a9b1c84572babd).
  buildOffchainTx wraps every input in a 2-leaf checkpoint, changing the scriptPubKey.

=== EXPERIMENT C: Empty Checkpoints ===

Introspector with empty checkpoint_txs: REJECTED
  Error: {"code":3, "message":"missing checkpoint txs"}

arkd with empty checkpoints: REJECTED
  Error: {"code":3, "message":"missing checkpoint txs"}
```

### B. Three-Leaf Taptree Structure

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

### C. Refresh Arkade Script Source

**4-byte workaround** (`buildRefreshArkadeScript()` in `src/covenant/arkade-script.ts`):

```typescript
export function buildRefreshArkadeScript(): Uint8Array {
  return new Uint8Array([
    0x00, 0xd1,   // OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY → [wp, version]
    0x51, 0x88,   // OP_1 OP_EQUALVERIFY → version == 1 (taproot)
    // Stack: [wp] — 32-byte witness program is non-zero = truthy
  ]);
}
```

**7-byte recursive covenant** (from `test/regtest/checkpoint-experiment.ts`):

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

### D. Leaf 0 Threat Model (4-byte workaround)

From `docs/COVENANT.md`:

> The refresh Arkade Script checks output taproot version only, not output destination. Hardcoding the witness program into the script is impossible due to circular dependency: the VTXO address is derived from the taptree which contains the Arkade Script which would contain the address. The output destination is enforced by the agent constructing the transaction to the same address.
>
> *Attack conditions for refresh output redirection:*
> - An attacker must compromise the agent process (not just extract a key — there is no key to extract).
> - The attacker must construct a valid offchain tx with a different taproot output address.
> - Both the Introspector AND arkd must co-sign. Neither checks output destination.
> - The redirect can only occur during a refresh or consolidation operation.
> - Between refresh windows, there is no transaction for the attacker to redirect.
> - The VTXO owner can race the attacker by spending via Leaf 1 (collaborative, alice + server) from their mobile app at any time.
>
> *Bottom line:* This is still dramatically better than a hot key on server (entire wallet extractable). In Tier 1.5, there is no key to extract. An attacker with sustained agent process access can redirect refresh outputs but must race the VTXO owner and can only act during refresh windows.

The recursive covenant (`00d100ca7b8887`) would eliminate this threat model entirely — the script enforces same-address output at the protocol level, removing the agent-integrity dependency.
