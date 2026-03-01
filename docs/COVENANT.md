# Golem — Covenant Architecture for Keyless Agent Receive

*Technical specification for review — March 2026*

---

## The Problem

AI agents running as cloud services need to receive Bitcoin payments (via Lightning/L402) without holding private keys. Today's options:

1. **Hot key on server** (LND, CLN, other agent wallet, Golem Phase 1): Key on disk. Same security as every Lightning node. If server is compromised, funds are lost.
2. **Delegation** (BIP-322 proofs, partial forfeits): Complex, requires periodic mobile app interaction for re-provisioning, still puts some signing capability on the server.
3. **Custodial** (other agent wallet AWS Nitro, Strike API): Someone else holds the keys. Not self-custodial.

None of these achieve: **server receives Lightning payments with zero key material, user retains full custody, agent operates autonomously.**

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

**Ark Labs maintainer (March 1, 2026):** "before this quarter ends" for introspection opcodes. Also confirmed: "There are two things here automatic renewal and HTLC claim that can be delegated to third party without handing over a key."

## Full Four-Leaf Taptree VTXO

Beyond just the claim script, the complete architecture for an agent-managed VTXO:

```
                    ┌─────────────────┐
                    │  Taproot Output  │
                    │   (VTXO key)     │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────┴─────┐ ┌─────┴─────┐ ┌─────┴─────┐
        │  Branch 1  │ │  Branch 2  │ │  Branch 3  │
        └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
              │              │              │
     ┌────┴────┐      ┌────┴────┐    ┌────┴────┐
     │ Leaf 1  │      │ Leaf 2  │    │ Leaf 3  │    │ Leaf 4  │
     │Covenant │      │Alice Key│    │Collab.  │    │Unilat.  │
     │(refresh)│      │(spend)  │    │(A+Op)   │    │(exit)   │
     └─────────┘      └─────────┘    └─────────┘    └─────────┘
```

**Leaf 1 — Recursive Covenant (agent-operated, no signature):**
- `OP_INSPECTINPUTSCRIPTPUBKEY` + `OP_INSPECTOUTPUTSCRIPTPUBKEY` enforce "output must carry same script as input"
- Covers VTXO refresh (self-send to extend expiry) AND consolidation (multiple inputs with same script → single output)
- `OP_INSPECTNUMOUTPUTS` enforces single output (prevents value siphoning)
- The agent uses this leaf for all autonomous operations. No key needed.

**Leaf 2 — Alice's Spending Key (user-operated):**
- Standard `<alice_pubkey> OP_CHECKSIG`
- Only way to move funds to a different address (withdrawal, spending)
- Key lives on mobile phone or hardware wallet. Never on server.
- This is the "recursion breaker" — the only leaf that can change the covenant.

**Leaf 3 — Collaborative Path (Ark protocol):**
- `<alice_pubkey> OP_CHECKSIGVERIFY <operator_pubkey> OP_CHECKSIG`
- Used for Arkade cooperative operations (OOR payments, round participation)
- Standard Ark pattern

**Leaf 4 — Unilateral Exit (emergency):**
- `<alice_pubkey> OP_CHECKSIG` with `OP_CSV <timelock>`
- If operator disappears, Alice can exit to on-chain after timelock
- Standard Ark safety mechanism

## What This Eliminates

| Component | Phase 1 (hot key) | Phase 2 (covenant) |
|-----------|-------------------|---------------------|
| Signing key on server | ✅ Required | ❌ Eliminated |
| Delegation credentials | N/A | ❌ Not needed |
| Monthly mobile provisioning | N/A | ❌ Not needed (for receive) |
| Key deletion concerns | ✅ Risk | ❌ Key never touches server |
| Sweep-based tier transitions | ✅ Complex | ❌ Unnecessary |

## Open Questions (Honest)

1. **Round/forfeit interaction:** When a covenant VTXO participates in an Ark round, does the forfeit transaction satisfy or violate the recursive covenant? If the covenant prevents forfeiture, covenant VTXOs can't participate in rounds. **This is the blocking question.** Scheduled for Ark Labs maintainer call.

2. **Boltz coordination:** Does the Arkade-Boltz gateway (`api.boltz.mutinynet.arkade.sh`) need to support covenant VHTLCs? Or can Golem construct swaps with a custom claim script via the existing API? If Boltz must update, timeline depends on Ark Labs + Boltz coordination.

3. **OP_SUCCESS semantics:** These opcodes use the OP_SUCCESS prefix in Arkade's VM. Need to confirm the VM never falls through to Bitcoin's unconditional-success behavior for these specific opcodes. If it did, the covenant could be bypassed.

4. **Script size limits:** Four-leaf taptree with recursive covenant script — does the total script size stay within Arkade's limits?

5. **VTXO expiry:** `arkade.computer` mainnet uses 7-day VTXO expiry (verified via live API query, corrected from earlier 30-day assumption). The RefreshAgent must be reliable. Covenant refresh eliminates the signing key requirement but doesn't eliminate the liveness requirement.

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
