# Golem — Covenant Architecture for Keyless Agent Receive

*Technical specification for review — March 2026*

---

## The Problem

AI agents running as cloud services need to receive Bitcoin payments (via Lightning/L402) without holding private keys. Today's options:

1. **Hot key on server** (LND, CLN, other agent wallet, Golem Phase 1): Key on disk. Same security as every Lightning node. If server is compromised, funds are lost.
2. **Delegation** (BIP-322 proofs, partial forfeits): Complex, requires periodic mobile app interaction for re-provisioning, still puts some signing capability on the server.
3. **Custodial** (other agent wallet AWS Nitro, Strike API): Someone else holds the keys. Not self-custodial.

None of these achieve: **server receives Lightning payments with zero key material, user retains full custody, agent operates autonomously.**

4. **Golem (covenants):** User generates keypair on mobile, imports pubkey to CLI via `golem init --import --pubkey <hex>`. Server receives payments with zero key material. Covenants enforce output constraints — no signature needed for receive or refresh. Private key never touches the server. User retains full custody via mobile app.

## The Insight

Arkade (the production Ark implementation by Ark Labs) supports introspection opcodes in its Script VM. These opcodes let a script examine the *transaction that's spending it* — specifically, what the outputs look like. This enables covenants: scripts that constrain where funds can go without requiring a signature.

**Critical distinction:** These covenants are enforced **off-chain** by the Introspector (a TEE-protected signing service), NOT by Bitcoin consensus. The Introspector evaluates Arkade Script in a forked btcd/txscript VM and co-signs if conditions are met. Bitcoin full nodes have no knowledge of Arkade Script. On the L1 exit path, covenant opcodes are NOT available — the exit path falls back to a plain `CHECKSIG + CSV` (see [Arkade Compiler](https://github.com/arkade-os/compiler)). This means covenant enforcement provides **liveness guarantees** (cheap/fast programmable operations), not **safety guarantees** (fund recovery). Safety comes from the unilateral exit path, which requires only the user's key + CSV timelock expiry.

## Covenant Claim Script

A standard Boltz VHTLC claim requires `preimage + signature`:

```
OP_SHA256 <hash> OP_EQUALVERIFY <receiver_pubkey> OP_CHECKSIG
```

The covenant-restricted version requires only `preimage`:

```
// Verify preimage (unchanged from standard HTLC)
OP_SHA256 <hash> OP_EQUALVERIFY

// Verify output[0] pays to Alice's exact taproot address
0 OP_INSPECTOUTPUTSCRIPTPUBKEY       // Push output[0]'s witness program + version
<1> OP_EQUALVERIFY                    // Segwit version = 1 (taproot)
<alice_witness_program> OP_EQUALVERIFY // Must be Alice's VTXO address

// Verify output[0] value ≥ expected amount
0 OP_INSPECTOUTPUTVALUE              // Push output[0]'s value
<expected_amount_le64> OP_GREATERTHANOREQUAL64 OP_VERIFY

// Prevent siphoning (optional but recommended)
OP_INSPECTNUMOUTPUTS
<1_le64> OP_EQUALVERIFY              // Exactly one output
```

**Witness to spend:** `<preimage>`. No signature. ~50-60 bytes of script.

**The three opcodes:**
| Opcode | Code | Purpose |
|--------|------|---------|
| `OP_INSPECTOUTPUTSCRIPTPUBKEY` | OP_SUCCESS209 (0xd1) | Verify output pays to exactly this address |
| `OP_INSPECTOUTPUTVALUE` | OP_SUCCESS207 (0xcf) | Verify output contains at least X sats |
| `OP_INSPECTNUMOUTPUTS` | OP_SUCCESS213 (0xd5) | Constrain to single output |

These are the same opcodes Arkade uses internally for `unroll.hack` shared output scripts. The VM evaluates them today. The question is when they're exposed for user-constructed scripts in production.

**Ark Labs maintainer (March 1, 2026):** "before this quarter ends" for introspection opcodes. Also confirmed: "There are two things here automatic renewal and HTLC claim that can be delegated to third party without handing over a key."

## Three-Leaf Taptree VTXO (Validated on Regtest)

The complete architecture for an agent-managed VTXO. Three leaves aligned with arkd's forfeit/exit classification model:

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

**Leaf 0 — Covenant Refresh (agent-operated, no signature):**
- `MultisigTapscript([introspector_tweaked_key, server_pubkey])`
- Introspector evaluates Arkade Script bytecode against the transaction
- The agent uses this leaf for all autonomous operations: 1:1 refresh and N:1 consolidation. No private key needed.
- Classified as "forfeit" by arkd (MultisigClosure) — contains server pubkey.

**Leaf 0 Arkade Script Options:**

*Option A — Version-only check (4 bytes: `00d15188`):*
`OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_1 OP_EQUALVERIFY` — checks output[0] is taproot (version == 1) only. Output destination enforced by agent constructing the transaction. Weaker: a compromised agent process could construct a tx to a different taproot address, and the Introspector would still sign (the Arkade Script passes for ANY taproot output).

*Option B — Full recursive covenant (7 bytes: `00d100ca7b8887`):*
`OP_0 OP_INSPECTINPUTSCRIPTPUBKEY OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_EQUALVERIFY` — enforces `input.scriptPubKey == output.scriptPubKey`. The output MUST have the same script as the input. A compromised agent cannot redirect outputs.

**Status (April 2026):** Option B is **implemented** in `buildRefreshArkadeScript()`. [ArkLabsHQ/introspector PR #63](https://github.com/ArkLabsHQ/introspector/pull/63) (merged Apr 15, 2026) fixed `OP_INSPECTINPUTSCRIPTPUBKEY` to trace through Ark's checkpoint wrapper and return the original VTXO's pkScript instead of the checkpoint WP. This was previously documented as Fix Option #1 ("Introspector trace-through mode") below. The fix adds `FetchVtxoPrevOutPkScript()` to the `ArkPrevOutFetcher` interface, which resolves the correct output from the Ark Tx at the proper index.

**Note on exit path:** The recursive covenant enforcement exists only in the Introspector's Arkade Script VM (off-chain). On the L1 unilateral exit path (Leaf 2), the covenant is NOT enforced — the exit script is plain `CHECKSIG + CSV`. This is by design: the Arkade compiler [automatically generates](https://github.com/arkade-os/compiler) a `serverVariant: false` exit path that strips covenant opcodes and replaces them with `checkSig(user) && after N blocks`. Covenant integrity depends on the Introspector; fund recovery does not.

*Prior state (resolved by PR #63):*

~~The root cause was that `OP_INSPECTINPUTSCRIPTPUBKEY` returned the checkpoint's witness program, not the original VTXO's. Ark's `buildOffchainTx` wraps every input in a 2-leaf checkpoint transaction (serverUnroll + collaborative). When the Introspector evaluated the Arkade Script, `OP_INSPECTINPUTSCRIPTPUBKEY` saw the checkpoint WP (2-leaf), not the VTXO WP (3-leaf), so `input == output` always failed.~~

~~Two possible fixes (both require Ark Labs changes, not Golem changes):~~
~~1. **Introspector "trace-through" mode:** Resolved by PR #63.~~
~~2. **arkd custom checkpoint taptrees:** No longer needed.~~

**Leaf 1 — Collaborative Path (user + server):**
- `<alice_pubkey> OP_CHECKSIGVERIFY <operator_pubkey> OP_CHECKSIG`
- Used for spending (alice signs on mobile), Ark protocol operations (OOR, rounds), and forfeit transactions.
- **Forfeit transactions require BOTH signatures** — the server cannot manufacture forfeits unilaterally. The user signs forfeits during round registration or offboard operations, and the server holds them as insurance.
- Key generated on mobile, pubkey imported to CLI via `golem init --import --pubkey <hex>`. Private key NEVER touches the server.
- This is the "recursion breaker" — the only leaf that can change the covenant destination.
- Classified as "forfeit" by arkd (MultisigClosure) — contains server pubkey.

**Leaf 2 — Unilateral Exit (emergency):**
- `<sequence> OP_CSV OP_DROP <alice_pubkey> OP_CHECKSIG`
- If operator disappears, Alice can exit to on-chain after timelock.
- Standard Ark safety mechanism.
- Classified as "exit" by arkd (CSVMultisigClosure).

**Why three leaves, not four?** arkd's `Validate()` (in `vtxo_script.go`) classifies ALL `MultisigClosure` leaves as "forfeit closures" and requires the server pubkey in every one. An alice-only `MultisigClosure` (for independent spending) fails with `"invalid forfeit closure, signer pubkey not found"`. The standard Ark model requires server participation in all non-exit spends — the collaborative leaf serves both spending and forfeit purposes. This was validated on regtest: the 4-leaf version failed; the 3-leaf version passes.

## What This Eliminates

| Component | Phase 1 (hot key) | Phase 1.5 (covenant) |
|-----------|-------------------|----------------------|
| Signing key on server | Required | Eliminated |
| Delegation credentials | N/A | Not needed |
| Monthly mobile provisioning | N/A | Not needed (for receive/refresh) |
| Key deletion concerns | Risk | Key never touches server |
| Sweep-based tier transitions | Complex | Unnecessary |

## Introspector Trust Model

The Introspector is a TEE-protected co-signing service that evaluates Arkade Script before signing. Understanding what it can and cannot do is critical for honest risk communication.

### Tweaked Key Construction

The Introspector does NOT hold a single signing key that signs anything. It holds a base key that is tweaked per-contract:

```
scriptHash = TaggedHash("ArkScriptHash", arkade_script)    // BIP-340 tagged hash
tweaked_pubkey = introspector_base_key + scriptHash * G     // EC point addition
tweaked_privkey = introspector_base_privkey + scriptHash    // scalar addition (with Y-parity negation)
```

Source: [`ArkLabsHQ/introspector/pkg/arkade/tweak.go`](https://github.com/ArkLabsHQ/introspector/blob/main/pkg/arkade/tweak.go). The tweak binds the Introspector's signing authority to a specific Arkade Script. An attacker who extracts the base key CAN derive tweaked keys for any script (scripts are public data), but the per-script binding means a single key compromise doesn't grant signing authority over arbitrary scripts outside the Introspector's domain.

### Forfeit Mechanics (Critical Correction)

Forfeit transactions **always require the user's signature**. The VTXO leaf has exactly two spend paths:
- **Cooperative/forfeit:** 2-of-2 (user + server). No timelock. Both sigs required.
- **Exit:** user-only with CSV relative timelock (~60 blocks / ~10 hours).

A forfeit transaction cannot exist unless the user previously signed it (during round registration, offboard, or OOR). The server/Introspector holds forfeits as insurance — it cannot manufacture them unilaterally.

Sources:
- [Second: Forfeits](https://second.tech/docs/learn/forfeits) — "The user signs this path to make a forfeit transaction"
- [Ark Protocol: VTXOs](https://docs.second.tech/ark-protocol/vtxo/) — "Leaf transactions use 2-of-2 multisigs between user and server for forfeits"
- [Arkade Docs](https://docs.arkadeos.com/learn/architecture/components) — "Each virtual transaction is cosigned by the respective VTXO owners and the Arkade Signer"

**Implication:** For Board/Refresh VTXOs that the user has never forfeited, an Introspector compromise does NOT create a race-to-broadcast attack. The attacker has no forfeit to race with. Unilateral exit succeeds (gated only on user key + CSV expiry + economic viability).

### What a Compromised Introspector Can Do

1. **Sign covenant-violating transactions** on the cooperative path — IF the other 2-of-2 signer (user or server) also signs. The covenant is enforced only by the Introspector's software; Bitcoin consensus has no knowledge of Arkade Script rules.

2. **Cosign with a stale user delegation** — If the user has pre-committed a SIGHASH_ALL|ANYONECANPAY delegation (e.g., for automated refresh), the attacker can combine it with an attacker-controlled connector input to redirect funds. This is the genuinely novel risk class Phase 1.5 introduces. Source: [Arkade blog — delegation mechanic](https://blog.arklabs.xyz/adios-expiry-rethinking-liveness-and-liquidity-in-arkade/).

3. **Refuse to sign** (censorship/griefing) — forcing users into unilateral exit.

### What a Compromised Introspector Cannot Do

1. **Unilaterally forge forfeit transactions** — requires user sig (see above).
2. **Prevent unilateral exit** — Leaf 2 (CSV + alice_key) bypasses Introspector entirely.
3. **Sign for scripts outside its domain** — the tweaked key is bound to specific Arkade Scripts (though an attacker with the base key can derive any tweak).

### Three-Way Trust Decomposition

**SAFETY (can user recover funds to L1?):**
- Board VTXOs: Does NOT depend on Introspector. CSV exit uses alice_key only.
- Refresh VTXOs: Same as Board. Trustless after round confirmation.
- OOR/Spend VTXOs: Temporarily depends on "sender + server not colluding." Trustless after refresh into a round.
- Covenant-encumbered VTXOs (Phase 1.5): Depends on Introspector integrity for covenant enforcement; compromised Introspector can cosign covenant-violating spends if user has pre-committed a delegation.

**LIVENESS (can user do cheap/fast/programmable ops?):**
- FULLY depends on Introspector being honest, online, uncompromised.
- Compromised/offline Introspector → user must fall back to unilateral exit (slower, more expensive).

**COVENANT INTEGRITY (are Arkade Script rules enforced?):**
- Depends on Introspector + TEE.
- If compromised, covenant rules become unenforced on the cooperative path.
- On the L1 exit path, covenants are NEVER enforced (exit script is plain CHECKSIG + CSV).

### Comparison to On-Chain Covenants

| Property | Introspector (Arkade) | OP_CTV (if activated) |
|---|---|---|
| Enforcement | Off-chain (TEE + software) | On-chain consensus |
| Can be bypassed? | Yes (key compromise) | No |
| Single point of failure | Yes (Introspector key/TEE) | No |
| Available today | Yes | No (needs soft fork) |
| Requires soft fork | No | Yes |

If OP_CTV or equivalent covenant opcodes were activated on Bitcoin, the Introspector would become unnecessary — its function would be replaced by on-chain consensus validation, eliminating the single point of failure entirely.

## Failure Mode Enumeration

Scenarios where a Golem user loses ability to recover funds to L1 under their control:

1. **User loses alice_key.** CSV exit requires user sig. No recovery. *(Not Introspector-related.)*

2. **VTXO expires before user broadcasts exit.** 7-day expiry on Arkade mainnet. After expiry, operator sweep path activates. *(Not Introspector-related.)*

3. **Exit cost exceeds VTXO value during fee spike.** Economic, not cryptographic. Deep tree position (3+ levels) during high-fee periods requires multiple sequential on-chain transactions. *(Not Introspector-related.)*

4. **Unrefreshed OOR/spend VTXO double-spent.** Previous sender colluded with ASP to double-spend before recipient refreshes into a round. Recipient loses broadcast race. *(Structural to ALL Ark implementations including Bark — not Introspector-specific. Introspector compromise just makes the "server" side of collusion freely available.)*

5. **Covenant-encumbered VTXO (Phase 1.5) spent via compromised Introspector cosigning with stale user delegation.** Funds go to attacker instead of covenant-specified destination. *(This IS the novel risk class Phase 1.5 introduces.)* Mitigated by: short intent TTLs, ephemeral covenant VTXOs (immediate refresh into standard VTXOs post-claim), and agent-as-watchtower monitoring.

6. **Wallet DB / presigned transaction data loss.** Seed phrase alone is insufficient to reconstruct the exit path — the pre-signed transaction tree is needed. *(Mitigated by: VTXO backup, libvpack-rs vendor-neutral recovery tooling.)*

**Removed from prior analysis:** "attacker uses compromised Introspector to unilaterally forfeit user's Board/Refresh VTXO" — this is cryptographically impossible. Forfeits require user signature (see Forfeit Mechanics above).

## Bark vs Arkade Divergence

Second (Bark) and Ark Labs (Arkade) implement the same Ark protocol but chose opposite architectural paths for covenants:

| | Arkade (Ark Labs) | Bark (Second) |
|---|---|---|
| Covenant model | Arkade Script VM + Introspector (TEE co-signer) | clArk (covenant-less): MuSig2 n-of-n, ephemeral key deletion |
| TEE dependency | Yes | No |
| Custom VM | Yes (~60 custom opcodes) | No |
| Keyless receive | Yes (via Introspector + Arkade Script) | No — cannot do keyless receive |
| Refresh atomicity | Connectors | Hash-locks (hArk, as of v0.1.0-beta.6) |
| CTV stance | Prove demand now, migrate when CTV activates | Wait for CTV as the "proper" path |

Steven Roose (Second CEO) actively pushes CTV+CSFS on [Delving Bitcoin](https://delvingbitcoin.org/t/the-ark-case-for-ctv/1528) as the canonical solution. Ark Labs maintainer's strategy — ship with Introspector now, migrate to on-chain covenants when available — is defensible on market-pull grounds but introduces the TEE trust assumption that Bark avoids.

This divergence between two competent teams implementing the same protocol is a substantive data point. Golem should represent it honestly, not gloss over it.

## External Trust Signals

**Arkade ToS admissions** (cite-able for investor/user comms):
- "Trusted Execution Environments provide security guarantees, but they are not perfect. Hardware vulnerabilities, side-channel attacks, or implementation flaws could compromise the Signer." — [Arkade ToS](https://arkadeos.com/terms-of-service)
- "Exit costs may exceed the VTXO value." — [Arkade ToS](https://arkadeos.com/terms-of-service)

**Bitcoin Layers** ([bitcoinlayers.org](https://www.bitcoinlayers.org/layers/arkade)): Arkade listed as "Under Review" with all four risk categories unscored (BTC Custody, Data Availability, Network Operators, Finality Guarantees).

**TEE security research:**
- Ledger Donjon: [TEE — When "Trusted" Doesn't Mean "Secure"](https://www.ledger.com/tee-when-trusted-doesnt-mean-secure) — side-channel attacks (Spectre, Meltdown), hardware manufacturer as ultimate root of trust.
- a16z: [TEE Primer](https://a16zcrypto.com/posts/article/trusted-execution-environments-tees-primer/) — "Build for privacy, not for integrity. TEEs should not be used as the only tool to protect the integrity of a blockchain protocol."

**Arkade compiler exit-path limitation:**
From [arkade-os/compiler](https://github.com/arkade-os/compiler): Each contract function compiles to two variants — cooperative (`serverVariant: true`, includes Arkade opcodes) and exit (`serverVariant: false`, plain `checkSig(user) && after N blocks`). Covenant opcodes like `OP_INSPECTOUTPUTSCRIPTPUBKEY` are NOT available in pure Bitcoin Script. Meaning: **the covenant enforces in the virtual mempool but does NOT enforce on L1.** Exit-path script is a plain CHECKSIG + CSV.

**Community tooling:**
[libvpack-rs](https://github.com/jgmcalpine/libvpack-rs) — vendor-neutral VTXO verifier and L1 exit transaction generator. Explicitly calls out "Vendor-Locked Recovery" as a risk. Potential collaboration target for Golem's unilateral exit story.

## Open Questions for Ark Labs maintainer

1. For RecursiveVtxo contracts, can the exit-path N-of-N be structured such that Alice can pre-commit a sweep to a specific user-designated safe-harbor L1 address at VTXO creation time, without requiring her live signature during exit? If yes, genuine keyless emergency exit. If no, the mobile PWA signer is load-bearing for the full trust-minimized story.

2. Does the Boltz Arkade gateway support covenant-restricted VHTLCs (`claimCovenant: true` equivalent for Ark)? This is the P0 gate for the claim daemon.

3. Is PR #63 deployed on the mainnet Introspector at arkade.computer? What version runs there?

## Resolved Questions

1. **Round/forfeit interaction:** Resolved. Covenant VTXOs participate in rounds normally. The refresh leaf (MultisigClosure with Introspector tweaked key + server) is classified as a "forfeit closure" by arkd. The server can construct forfeit transactions using this leaf. Validated on regtest.

2. **OP_SUCCESS semantics:** Confirmed safe. Arkade's VM executes these opcodes (OP_HASH160, OP_INSPECTOUTPUTSCRIPTPUBKEY, OP_INSPECTOUTPUTVALUE, OP_INSPECTINPUTSCRIPTPUBKEY, OP_GREATERTHANOREQUAL64) with proper semantics. The Introspector evaluates Arkade Script bytecode against the ark transaction context.

3. **Script size limits:** Three-leaf taptree with Arkade Scripts fits well within limits. Refresh Arkade Script is 4-7 bytes. Claim Arkade Script is ~73 bytes.

4. **Recursive covenant for refresh:** RESOLVED (April 2026). [ArkLabsHQ/introspector PR #63](https://github.com/ArkLabsHQ/introspector/pull/63) (merged Apr 15, 2026) implemented Fix Option #1 ("Introspector trace-through mode"). `OP_INSPECTINPUTSCRIPTPUBKEY` now returns the original VTXO's pkScript instead of the checkpoint WP. The 7-byte recursive covenant (`00d100ca7b8887`: `input[0].scriptPubKey == output[0].scriptPubKey`) now works correctly. See Leaf 0 section above for details.

## What Golem Has Today (Phase 1)

- 336 passing tests
- Live on mutinynet
- ServerSigner with encrypted hot key
- L402 gateway (Aperture-equivalent) with dual-mode payment:
  - Lightning path: standard L402 via Boltz reverse swap
  - Ark-native path: direct OOR payment
- L402 macaroon implementation (~60 lines, zero dependencies)
- Agent wallet mode with spending caps
- CLI: `golem init`, `golem balance`, `golem gateway`, `golem stats`
- First third-party transaction: 21,000 sats sent to Ark Labs maintainer
- Timing: 402 challenge in 139ms, Lightning payment in ~1s, token verify in 9ms
- 402index.io live: 13,196 endpoints, 510 services, 400 providers

## Pika Integration Points

If Pika is a Nostr-based encrypted messaging client for AI agents:

- **Pika agents that consume APIs** → Golem agent wallet mode (L402 client, auto-pay within caps)
- **Pika agents that provide APIs** → Golem L402 gateway (receive payments, no key on server)
- **Service discovery** → 402index.io / Golem Service Directory (DNS for paid APIs)
- **Nostr backbone** → Could serve both messaging (Pika) and service directory (Golem Phase 3)
- **Combined value prop:** Agents that can communicate securely (Signal encryption) AND transact autonomously (covenant-secured receive), both without holding key material they shouldn't have.

## Ark Ecosystem Context

- Ark Labs raising $7M (Tether + others, announcement imminent)
- Public beta since Oct 2025. Partners: Breez, BlueWallet, BTCPayServer, BullBitcoin, Boltz
- Stablecoins: Fuji (BTC-backed) shipping in weeks. Close with USDT0 team. Taproot Assets supported.
- Boltz Arkade gateway: 333-sat mainnet minimums (enables micropayments)
- 1-minute round sessions on mainnet
