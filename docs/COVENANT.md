# Golem — Covenant Architecture for Keyless Agent Receive

*Technical specification for review — March 2026*

---

## The Problem

AI agents running as cloud services need to receive Bitcoin payments (via Lightning/L402) without holding private keys. Today's options:

1. **Hot key on server** (LND, CLN, Claw Cash, Golem Phase 1): Key on disk. Same security as every Lightning node. If server is compromised, funds are lost.
2. **Delegation** (BIP-322 proofs, partial forfeits): Complex, requires periodic mobile app interaction for re-provisioning, still puts some signing capability on the server.
3. **Custodial** (Claw Cash AWS Nitro, Strike API): Someone else holds the keys. Not self-custodial.

None of these achieve: **server receives Lightning payments with zero key material, user retains full custody, agent operates autonomously.**

4. **Golem (covenants):** User generates keypair on mobile, imports pubkey to CLI via `golem init --import --pubkey <hex>`. Server receives payments with zero key material. Covenants enforce output constraints — no signature needed for receive or refresh. Private key never touches the server. User retains full custody via mobile app.

## The Insight

Arkade (the production Ark implementation by Ark Labs) supports introspection opcodes in its Script VM. These opcodes let a script examine the *transaction that's spending it* — specifically, what the outputs look like. This enables covenants: scripts that constrain where funds can go without requiring a signature.

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

**Tiero (March 1, 2026):** "before this quarter ends" for introspection opcodes. Also confirmed: "There are two things here automatic renewal and HTLC claim that can be delegated to third party without handing over a key."

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
- Introspector evaluates Arkade Script bytecode: `OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_1 OP_EQUALVERIFY` (4 bytes: `00d15188`)
- Checks output[0] is taproot (version == 1). Agent enforces output destination = same address.
- The agent uses this leaf for all autonomous operations. No private key needed.
- Classified as "forfeit" by arkd (MultisigClosure) — contains server pubkey.

**Leaf 1 — Collaborative Path (user + server):**
- `<alice_pubkey> OP_CHECKSIGVERIFY <operator_pubkey> OP_CHECKSIG`
- Used for spending (alice signs on mobile), Ark protocol operations (OOR, rounds), and forfeit transactions.
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

## Resolved Questions

1. **Round/forfeit interaction:** Resolved. Covenant VTXOs participate in rounds normally. The refresh leaf (MultisigClosure with Introspector tweaked key + server) is classified as a "forfeit closure" by arkd. The server can construct forfeit transactions using this leaf. Validated on regtest.

2. **OP_SUCCESS semantics:** Confirmed safe. Arkade's VM executes these opcodes (OP_HASH160, OP_INSPECTOUTPUTSCRIPTPUBKEY, OP_INSPECTOUTPUTVALUE, OP_INSPECTINPUTSCRIPTPUBKEY, OP_GREATERTHANOREQUAL64) with proper semantics. The Introspector evaluates Arkade Script bytecode against the ark transaction context.

3. **Script size limits:** Three-leaf taptree with Arkade Scripts fits well within limits. Refresh Arkade Script is just 4 bytes (`00d15188`). Claim Arkade Script is ~73 bytes.

## Open Questions

1. **Boltz coordination:** Does the Arkade-Boltz gateway (`api.boltz.mutinynet.arkade.sh`) need to support covenant VHTLCs? Or can Golem construct swaps with a custom claim script via the existing API? If Boltz must update, timeline depends on Ark Labs + Boltz coordination.

2. **Recursive covenant for refresh:** The ideal recursive covenant (`OP_INSPECTINPUTSCRIPTPUBKEY == OP_INSPECTOUTPUTSCRIPTPUBKEY`) doesn't work with Ark's checkpoint architecture. `buildOffchainTx` wraps every input in a 2-leaf checkpoint transaction, so the arkTx's input scriptPubKey differs from the original VTXO's. Current workaround: check output taproot version only, agent enforces destination. Full recursive covenant requires either Introspector "trace through checkpoints" support, or arkd accepting custom checkpoint taptrees.

3. **VTXO expiry:** `arkade.computer` mainnet uses 7-day VTXO expiry. The RefreshAgent must be reliable. Covenant refresh eliminates the signing key requirement but doesn't eliminate the liveness requirement.

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
- First third-party transaction: 21,000 sats sent to Tiero
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
