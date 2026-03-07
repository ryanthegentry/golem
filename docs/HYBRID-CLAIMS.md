# Golem-Ark — Hybrid Claim Architecture

*Spec for cooperative claims + covenant VTXOs on Ark. March 2026.*

---

## Context

golem-liquid validated cooperative MuSig2 claims on Liquid mainnet (March 7, 2026). The gateway creates an ephemeral keypair per swap, co-signs with Boltz via `/v2/swap/reverse/{id}/claim`, and discards the key. No persistent key material on the server after `init`. This is Tier 0.5.

The question: how do we port this to Ark, and how does it interact with the covenant architecture described in COVENANT.md?

**Answer: They solve different layers.** Cooperative claims handle the Boltz swap step (Lightning → VTXO). Covenants handle the VTXO lifecycle (refresh, consolidation without master key). This doc specs the hybrid.

## Two-Layer Architecture

```
Layer 1: Swap Claims (Lightning → VTXO)
┌─────────────────────────────────────────────────────────┐
│  ON LIQUID/BITCOIN (on-chain):                           │
│  PRIMARY: Cooperative MuSig2 claim with Boltz            │
│  • Ephemeral per-swap keypair (random 32 bytes)          │
│  • Nonce exchange via /v2/swap/reverse/{id}/claim         │
│  • Key exists in memory for seconds, then discarded      │
│  • Blast radius: one in-flight swap amount               │
│  FALLBACK: Covenant claim (Liquid only, introspection)   │
│                                                          │
│  ON ARK (virtual, via Introspector):                     │
│  PRIMARY: Covenant claim via Introspector                │
│  • preimage + OP_INSPECTOUTPUTSCRIPTPUBKEY + server sig  │
│  • No receiver key — Introspector enforces output        │
│  • Instant — offchain virtual spend, no on-chain tx      │
│  • Blast radius: ZERO (no key material involved)         │
│  FALLBACK: Standard hashlock (ephemeral receiver key)    │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
                   Funds arrive as VTXO
                         │
                         ▼
Layer 2: VTXO Lifecycle (refresh, consolidation, spend)
┌─────────────────────────────────────────────────────────┐
│  REFRESH + CONSOLIDATION: Covenant (Leaf 0)              │
│  • Covenant via Introspector + Arkade Script              │
│  • No key needed — agent submits to ASP autonomously     │
│  • Handles both 1:1 refresh and N:1 consolidation        │
│                                                          │
│  SPEND + WITHDRAW + FORFEIT: Collaborative (Leaf 1)      │
│  • alice + server multisig for spending, OOR, rounds     │
│  • Alice signs on mobile, server co-signs                │
│  • Also used by arkd for forfeit transactions            │
│  • Private key never touches the server                  │
│                                                          │
│  EMERGENCY EXIT: Timelock (Leaf 2)                       │
│  • alice + CSV for unilateral exit if operator disappears │
└─────────────────────────────────────────────────────────┘
```

## How the Introspector Works

The Introspector is the covenant enforcement mechanism on Ark. It's not a Bitcoin consensus-level covenant — it's an application-layer signing oracle deployed alongside arkd.

```
Gateway                    Introspector                 ASP (arkd)
  │                            │                           │
  │  Submit offchain tx with   │                           │
  │  Introspector Packet       │                           │
  │  (TLV: magic 0x41524b,    │                           │
  │   script bytecode,         │                           │
  │   witness args)            │                           │
  │───────────────────────────►│                           │
  │                            │                           │
  │  Introspector:             │                           │
  │  1. Decode Arkade Script   │                           │
  │  2. Execute opcodes        │                           │
  │  3. Verify output address  │                           │
  │  4. Verify output value    │                           │
  │  5. Check tweaked key      │                           │
  │     matches tapscript      │                           │
  │                            │                           │
  │  If valid: sign with       │                           │
  │  tweaked_key =             │                           │
  │  introspector_key +        │                           │
  │  hash(arkade_script)       │                           │
  │                            │                           │
  │  { signature }             │                           │
  │◄───────────────────────────│                           │
  │                            │                           │
  │  Submit signed tx to ASP   │                           │
  │────────────────────────────────────────────────────────►│
  │                            │                           │
```

The tweaked key (`introspector_key + hash(arkade_script)`) is embedded in a `MultisigClosure` tapscript leaf. The ASP sees a standard multisig — it doesn't need to know about the introspection. The Introspector handles all covenant validation.

## The Claim Flow

### Step 1: Client requests API access

```
Client → Gateway: GET /api/data
Gateway → Client: 402 + L402 macaroon + Lightning invoice
```

### Step 2: Client pays Lightning invoice

Boltz reverse swap creates a VHTLC. On Liquid this was a standard HTLC output. On Ark, Boltz locks funds as a VHTLC (Virtual HTLC) inside the Ark tree.

### Step 3 (ON ARK — PRIMARY): Covenant claim via Introspector

```
Gateway                    Introspector                 ASP
  │                            │                          │
  │  VHTLC detected in Ark    │                          │
  │  tree (Boltz locked funds) │                          │
  │                            │                          │
  │  Build offchain claim tx:  │                          │
  │  • Input: VHTLC            │                          │
  │  • Output: covenant VTXO   │                          │
  │  • Witness: <preimage>     │                          │
  │  • Introspector Packet:    │                          │
  │    covenant script bytecode│                          │
  │                            │                          │
  │  Request co-signature      │                          │
  │───────────────────────────►│                          │
  │                            │                          │
  │  Introspector validates:   │                          │
  │  • preimage matches hash   │                          │
  │  • output[0] = Alice VTXO  │                          │
  │  • output value ≥ expected │                          │
  │  Signs with tweaked key    │                          │
  │                            │                          │
  │  { signature }             │                          │
  │◄───────────────────────────│                          │
  │                            │                          │
  │  Submit signed claim       │                          │
  │───────────────────────────────────────────────────────►│
  │                            │                          │
```

**No receiver key needed.** The Introspector enforces the output constraint. The preimage is the only secret. Output is a covenant-enabled VTXO that the agent manages autonomously.

### Step 3 (ON ARK — FALLBACK): Standard hashlock claim

If Introspector is unavailable, fall back to the standard hashlock collaborative path: `preimage + receiver_sig + server_sig`. This requires an ephemeral receiver key (same as Tier 0.5 on Liquid).

### Step 3 (ON LIQUID/BITCOIN): Cooperative MuSig2 claim

On-chain claims use the golem-liquid pattern: ephemeral keypair → MuSig2 nonce exchange with Boltz via `POST /v2/swap/reverse/{id}/claim` → aggregate signatures → broadcast. Validated on Liquid mainnet (tx `f686839d`).

### Step 4: Agent manages VTXO lifecycle (covenant)

Once funds land in a covenant-enabled VTXO:

- **Refresh:** Agent submits Leaf 1 spend to next Ark round. Output must carry same taptree script. No signature.
- **Consolidation:** Multiple covenant VTXOs with same script → single output. Leaf 1 allows N:1 because it checks script equality, not specific UTXO identity.
- **Spend/Withdraw:** User opens mobile app, signs via Leaf 2 (master key). This is the recursion breaker.

## Security Tiers (Updated)

| Tier | Name | Swap Claim | VTXO Lifecycle | Key on Server | Blast Radius |
|------|------|-----------|---------------|--------------|-------------|
| 0 | ServerSigner | Master key signs claim | Master key signs refresh | Hot master key | Entire wallet |
| 0.5 | Cooperative | Ephemeral MuSig2 with Boltz | Master key signs refresh | Hot master key (for refresh only) | One in-flight swap |
| 1 | Mobile | Ephemeral MuSig2 with Boltz | User signs refresh from app | None (sweep to mobile) | One in-flight swap |
| 1.5 | Hybrid | Ephemeral MuSig2 (primary) + covenant fallback | Covenant refresh (Leaf 1) | **None** | One in-flight swap (cooperative) or zero (covenant fallback) |

**Tier 0.5 is what golem-liquid validated today.** The master key is still on the server for VTXO lifecycle operations (refresh, consolidation), but swap claims use ephemeral keys.

**Tier 1.5 is the target.** Both swap claims AND VTXO lifecycle operate without a master key on the server. The server holds zero persistent key material. Cooperative claims use ephemeral keys (discarded after each swap). Covenant refresh uses introspection opcodes (no key at all).

## What Tier 1.5 Eliminates vs. Tier 0

| Concern | Tier 0 | Tier 0.5 (today) | Tier 1.5 (target) |
|---------|--------|-------------------|---------------------|
| Key on server | Hot master key | Hot master key (refresh) + ephemeral (claims) | **None** |
| Swap compromise | Entire wallet | One in-flight swap | One in-flight swap (coop) or nothing (covenant) |
| Server breach | Attacker gets wallet | Attacker gets wallet (still has master key for refresh) | **Attacker gets nothing** |
| Delegation needed | No | No | No |
| Monthly provisioning | No | No | No |

## Implementation Path (Revised)

Tiero's Introspector guidance collapses Phase A and Phase B into a single step. On Ark, the covenant claim IS the primary claim path from day one. No intermediate Tier 0.5 needed.

### Phase A: Covenant claim on regtest (Now)

Gated on: Nothing. All tools exist today.

**Dev environment:**
1. Spin up Introspector regtest: `docker-compose -f docker-compose.regtest.yml up` (includes arkd + Introspector + Bitcoin regtest)
2. Spin up Boltz regtest: `BoltzExchange/regtest` (may need separate compose or `--profile ark` if it exists)
3. If Boltz regtest doesn't include Ark, use Introspector's own compose (likely includes everything needed)

**Implementation:**
1. Start from Arkade's hashlock contract example (docs.arkadeos.com/contracts/hashlock)
2. Add the covenant claim leaf per Tiero's guidance: `preimage_hash + OP_INSPECTOUTPUTSCRIPTPUBKEY + introspector_tweaked_key`
3. Write the Arkade Script bytecode by hand (no compiler — raw opcode construction)
4. Register the VHTLC via `ContractManager.createContract()` with the custom tapscript
5. Test claim: provide preimage → Introspector validates output pays to Alice's address → signs → VTXO created
6. Verify the claimed VTXO has the four-leaf taptree structure

**This gets us directly to Tier 1.5 on regtest.** No ephemeral keys, no MuSig2, no intermediate steps.

### Phase B: VTXO lifecycle on regtest

Gated on: Phase A working.

1. Test covenant refresh: agent spends via Leaf 1 (recursive covenant) to extend VTXO expiry
2. Test consolidation: multiple covenant VTXOs → single output via Leaf 1
3. Test forfeit: verify covenant VTXOs participate in Ark rounds via Leaf 3
4. Test spend: user claims via Leaf 2 (master key)
5. Test unilateral exit: user exits via Leaf 4 (timelock)

### Phase C: L402 gateway integration on regtest

Gated on: Phase A + B working.

1. Port golem's L402 gateway to use Arkade SDK instead of Boltz API for claims
2. Gateway creates reverse swap → Boltz pays → VHTLC appears in Ark tree → gateway claims via covenant → VTXO created
3. Full L402 flow: 402 challenge → Lightning payment → covenant claim → API access granted

### Phase D: Mainnet deployment

Gated on: Introspector deployed alongside `arkade.computer` (mainnet ASP).

1. Same code, point at mainnet ASP
2. Verify Introspector signing works on mainnet
3. Production L402 gateway with covenant claims

## VTXO Address Construction

For Tier 1.5, the covenant claim output pays to a taproot address with this taptree:

```
Internal key: TAPROOT_UNSPENDABLE_KEY (NUMS point — no key-path spend)

Script tree (3 leaves):
├── Leaf 0: Covenant refresh (agent-operated, no signature)
│   MultisigTapscript [introspector_tweaked_key, server_key]
│   Arkade Script: OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_1 OP_EQUALVERIFY
│
├── Leaf 1: Collaborative (spend, OOR, rounds, forfeit)
│   <alice_pubkey> OP_CHECKSIGVERIFY <operator_pubkey> OP_CHECKSIG
│
└── Leaf 2: Unilateral exit (emergency)
    <timelock> OP_CSV OP_DROP <alice_pubkey> OP_CHECKSIG
```

The CLI never generates a seed. `alice_pubkey` is imported from the mobile wallet during `golem init --import --pubkey <hex>` (32-byte x-only secp256k1). The private key is generated on the mobile device and NEVER touches the server. `operator_pubkey` comes from the ASP connection (`/v1/info`). `introspector_tweaked_key` is derived as `introspector_base_key + TaggedHash("ArkScriptHash", refresh_arkade_script) * G`. All values available at init time.

## Esplora Timing Issue (RESOLVED)

Cooperative claim on `transaction.mempool` failed on Liquid because Esplora hadn't indexed the lockup tx yet.

**Fix confirmed:** Boltz WebSocket events include `transaction.hex` — the raw transaction encoded as hex. We can parse the lockup tx directly from the event payload without querying Esplora. This eliminates the timing issue for on-chain claims on both Liquid and Bitcoin.

On Ark, VHTLCs are virtual (inside the Ark tree), so the Esplora issue doesn't apply at all — there's no on-chain transaction to index.

---

## Research Findings (March 7, 2026)

### Round 1: Boltz API + Arkade SDK docs

Investigated each open question against Boltz API docs, Arkade SDK docs, arkd release notes, and Ark protocol specs.

**Q1: RESOLVED — Boltz cooperative claims work for Bitcoin.** API docs list BTC, L-BTC, RBTC for `POST /swap/reverse/{id}/claim`. Chain-agnostic MuSig2. Phase A unblocked.

**Q2: RESOLVED — Client constructs claim output freely.** Boltz co-signs the input (lockup spend). Output address is entirely the client's choice. We can target covenant VTXO addresses.

**Q3: RESOLVED — Arkade v0.4+ supports custom tapscripts.** arkd v0.4 introduced agnostic VtxoScript (#384), custom collaborative paths (#392), reworked forfeit validation (#382). Rule: forfeit path must exist, unilateral paths must be timelocked. Our four-leaf taptree satisfies both.

**Q4: RESOLVED — Forfeit path is separate from covenant leaf.** Forfeit uses Leaf 3 (alice+ASP multisig), independent of Leaf 1 (covenant). Each tapscript leaf is a separate spend path. Covenant VTXOs can participate in rounds.

**Q5: RESOLVED — Swap creation requires only a pubkey.** `POST /swap/reverse` takes `{ claimPublicKey, preimageHash }`. No signature. Tier 0.5 achievable.

**Q7: RESOLVED — WebSocket events include `transaction.hex`.** Raw tx in event payload. Esplora timing issue eliminated.

**Q8: DEFERRED — Upstream contribution.** Bypass `@arkade-os/boltz-swap` for now.

### Round 2: Tiero's Introspector Guidance (March 7, 2026)

Tiero provided direct guidance for implementing covenants on Ark today:

> "https://github.com/ArkLabsHQ/introspector/blob/master/docker-compose.regtest.yml
> So he would have to write opcodes by hand and this a good starting point tell him to add an additional collaborative path where there is preimage hash + introspect script pubkey opcode + server sig
> https://docs.arkadeos.com/contracts/hashlock"

This resolves Q6, Q9, and fundamentally reframes the architecture.

**Key insight: The Introspector IS the covenant mechanism on Ark.** It's not a Bitcoin consensus-level covenant. It's an application-layer signing oracle that:

1. Receives the Arkade Script (bytecode) via an Introspector Packet (TLV stream in OP_RETURN, magic bytes `ARK` / 0x41524b)
2. Executes the script against the actual transaction (introspection opcodes inspect inputs, outputs, values, scripts)
3. Signs with a tweaked key `introspector_key + hash(arkade_script)` ONLY if the script validates
4. The tweaked key is embedded in a `MultisigClosure` tapscript leaf

This means covenants on Ark don't require consensus changes. They require the Introspector service, which already exists and runs alongside arkd. The docker-compose.regtest.yml provides the complete local dev environment.

**Q6: RESOLVED — Introspection opcodes are available NOW via Introspector.** The Introspector supports 40+ opcodes including all the ones we need: `OP_INSPECTINPUTSCRIPTPUBKEY`, `OP_INSPECTOUTPUTSCRIPTPUBKEY`, `OP_INSPECTOUTPUTVALUE`, `OP_INSPECTNUMOUTPUTS`. These are not gated on a future Arkade release. They're available today on regtest via the Introspector docker-compose, and in production wherever the Introspector is deployed alongside arkd.

**Q9: RESOLVED — VHTLC claims on Ark use the Arkade SDK, not Boltz API.** The hashlock contract docs show the claim flow: query spendable VTXOs → `buildOffchainTx()` → sign with receiver credentials → submit to ASP for cosignature → finalize checkpoint. This is an ASP-mediated virtual spend, not an on-chain broadcast. The Boltz reverse swap creates the VHTLC inside the Ark tree. The gateway claims it via the Arkade SDK's offchain transaction API.

**Tiero's specific guidance for the claim script:**

The existing hashlock contract has a collaborative path: `preimage_hash + receiver_sig + server_sig`. Tiero says to add an ADDITIONAL collaborative path with: `preimage_hash + OP_INSPECTOUTPUTSCRIPTPUBKEY (introspection) + server_sig`. This is the covenant claim path — it replaces the receiver signature with an introspection check that the output pays to the correct address. The server (Introspector) validates the script and provides its signature.

**Revised claim script for Golem:**

```
Standard hashlock (Arkade default):
  Collaborative: HASH160 <hash> EQUALVERIFY <receiver> CHECKSIGVERIFY <server> CHECKSIG
  Unilateral:    HASH160 <hash> EQUALVERIFY <receiver> CHECKSIG (with CSV timelock)

Golem covenant claim (additional collaborative path):
  HASH160 <hash> EQUALVERIFY                        // Verify preimage
  0 OP_INSPECTOUTPUTSCRIPTPUBKEY                     // Push output[0] script
  <1> EQUALVERIFY                                    // Segwit v1 (taproot)
  <alice_witness_program> EQUALVERIFY                // Must be Alice's VTXO address
  0 OP_INSPECTOUTPUTVALUE                            // Push output[0] value
  <expected_amount_le64> OP_GREATERTHANOREQUAL64     // Sufficient amount
  OP_VERIFY
  <introspector_tweaked_key> OP_CHECKSIG             // Introspector signs if script passes
```

The Introspector acts as the covenant enforcer: it evaluates the script, verifies the output pays to Alice's address with sufficient value, and co-signs. No receiver key needed. The preimage is the claim authorization, the Introspector is the spending constraint.

### Revised Architecture

This changes the hybrid architecture significantly. On Ark, there is no on-chain MuSig2 cooperative claim step at all. The entire flow is virtual:

```
Layer 1: Swap Claims (Lightning → VTXO) — ON ARK
┌─────────────────────────────────────────────────────────┐
│  PRIMARY: Covenant claim via Introspector                │
│  • VHTLC registered as hashlock contract in Ark tree    │
│  • Claim path: preimage + introspection + server sig     │
│  • No receiver key needed — Introspector enforces output │
│  • Instant — offchain virtual spend, no on-chain tx      │
│  • Blast radius: zero (no key material involved)         │
│                                                          │
│  FALLBACK: Standard hashlock claim                       │
│  • preimage + receiver sig + server sig                  │
│  • Requires receiver key (ephemeral or master)           │
│  • Same speed — still offchain virtual spend             │
└─────────────────────────────────────────────────────────┘
```

**This is better than the Liquid architecture.** On Liquid, cooperative MuSig2 claims need an ephemeral key (Tier 0.5). On Ark with Introspector, the PRIMARY claim path is already keyless (Tier 1.5). The standard hashlock with a receiver key becomes the FALLBACK.

---

## Updated Open Questions

### Remaining (2 questions, both can be answered on regtest)

**Q10: Introspector deployment status on production Arkade.**
The Introspector exists and works on regtest. Is it deployed alongside `arkade.computer` (mainnet ASP)? If not, when? This determines whether covenant claims work on mainnet or only regtest.
*Priority: Medium. Regtest development can proceed regardless.*

**Q11: Boltz regtest `--profile ark` — does it exist?**
Ryan mentioned `BoltzExchange/regtest` with `--profile ark`. Couldn't confirm this profile exists in the public repo. May be a recent addition or Tiero may have been referring to the Introspector's own `docker-compose.regtest.yml` which includes Boltz services. Need to check the actual compose file.
*Priority: Low. The Introspector docker-compose.regtest.yml may already include everything needed.*

### Resolved (all original questions)

- ~~Q1: Boltz Bitcoin cooperative claims~~ → **Yes, supported.**
- ~~Q2: Custom taptree claim outputs~~ → **Yes, client constructs freely.**
- ~~Q3: Arkade SDK custom tapscripts~~ → **Yes, since arkd v0.4.**
- ~~Q4: Round/forfeit vs covenant~~ → **Separate leaves, no conflict.**
- ~~Q5: Swap creation key requirements~~ → **Pubkey only.**
- ~~Q6: Introspection opcodes timeline~~ → **Available NOW via Introspector.**
- ~~Q7: WebSocket raw tx hex~~ → **Yes, included in event payload.**
- ~~Q8: Upstream contribution~~ → **Deferred.**
- ~~Q9: VHTLC claim path~~ → **Arkade SDK virtual spend, not Boltz API.**

---

## Regtest Validation Results

### Phase 1: Hashlock Baseline (Commit 8d79bc2)

Standard VHTLC create→fund→claim on regtest using the SDK's `VHTLC.Script` class. Collaborative path: `preimage + receiver_sig + server_sig`.

- Test: `test/regtest/hashlock-baseline.ts`
- arkd v0.8.11 (nigiri --ark --ci)
- Key learning: `ConditionWitness` (preimage) must be set on BOTH the ark tx AND checkpoint PSBTs before signing. Without it on checkpoints, `finalizeTx` fails with `INVALID_SIGNATURE`.

### Phase 2: Covenant Claim via Introspector (Commit TBD)

Keyless claim using Introspector as covenant enforcer. The receiver's private key is NOT used for the claim — only the preimage + Introspector signature + server signature.

- Test: `test/regtest/covenant-claim.ts`
- arkd v0.9.0-rc.4 + Introspector (docker-compose.regtest.yml)
- Custom VtxoScript with 6 tapscript leaves:
  - Leaf 0: **Covenant claim** — plain `MultisigTapscript` with `[introspector_tweaked_key, server_key]`
  - Leaf 1: Standard hashlock claim (fallback) — `ConditionMultisigTapscript` with `[receiver_key, server_key]`
  - Leaf 2: Refund — `MultisigTapscript` with `[sender, receiver, server]`
  - Leaves 3-5: Unilateral claim/refund paths with CSV timelocks

**Key technical discoveries:**

1. **Introspector only parses `MultisigClosure` tapscripts.** Using `ConditionMultisigTapscript` (which prepends condition script) makes the leaf invisible to the Introspector. The covenant claim leaf must be a PLAIN `MultisigTapscript`. The HASH160 preimage check goes into the Arkade Script bytecode (in the OP_RETURN Introspector Packet), not the tapscript.

2. **OP_RETURN must be in `buildOffchainTx` outputs.** Adding OP_RETURN after `buildOffchainTx` changes the txid, making checkpoints reference the wrong tx. The Introspector Packet must be included in the `outputs` array passed to `buildOffchainTx`.

3. **Checkpoints need Introspector co-signing after arkd's `submitTx`.** arkd creates its own checkpoint PSBTs during `submitTx`, so the Introspector's signature from the initial signing is lost. Flow: build → Introspector signs → arkd signs (creates new checkpoints) → Introspector signs checkpoints again → finalize.

4. **arkd v0.8.11 does NOT support OP_RETURN outputs.** Returns `AMOUNT_TOO_LOW` for 0-value outputs. arkd v0.9.0-rc.4 is required for Introspector Packet support.

5. **Arkade Script bytecode** (73 bytes, hand-constructed):
   ```
   OP_HASH160 <20-byte preimage_hash> OP_EQUALVERIFY     // Verify preimage
   OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_1 OP_EQUALVERIFY // Check taproot v1
   <32-byte witness_program> OP_EQUALVERIFY               // Check recipient address
   OP_0 OP_INSPECTOUTPUTVALUE <8-byte amount_LE> OP_GTE64 // Check min amount
   ```

6. **Introspector Packet encoding** (in OP_RETURN):
   ```
   OP_RETURN + push_opcode + "ARK" + TLV(type=0x01, uvarint_len, payload)
   Payload: varint(entry_count) + [u16_LE(vin) + varint(script_len) + script + varint(witness_len) + witness]
   Witness: standard Bitcoin witness format (varint(count) + [varint(len) + bytes])
   ```

7. **Key tweaking**: `tweaked_key = introspector_base_key + TaggedHash("ArkScriptHash", arkade_script) * G`

**Result:** Full end-to-end covenant claim on regtest. 10,000 sats claimed from VHTLC to recipient VTXO with zero key material.

### Phase 3: Three-Leaf Covenant VTXO Output (Commit TBD)

The claim output is now a three-leaf covenant VTXO. This VTXO supports autonomous agent operations (refresh, consolidation) via the covenant refresh leaf, while preserving user custody via the collaborative path.

**Three-leaf taptree structure:**

| Leaf | Purpose | Script | Key Required | arkd Classification |
|------|---------|--------|--------------|---------------------|
| 0 | Covenant refresh (agent-operated) | `MultisigTapscript [refresh_tweaked_key, server_key]` | None (Introspector) | Forfeit |
| 1 | Collaborative (spend, OOR, rounds, forfeit) | `MultisigTapscript [alice_key, server_key]` | Alice + server | Forfeit |
| 2 | Unilateral exit (emergency) | `CSVMultisigTapscript [alice_key]` with timelock | Alice (after CSV) | Exit |

**Why three leaves, not four?** arkd's `Validate()` classifies all `MultisigClosure` leaves as "forfeit closures" and requires the server pubkey in every one. An alice-only `MultisigClosure` (for independent spending) fails with `"invalid forfeit closure, signer pubkey not found"`. Alice spends via the collaborative leaf (standard Ark model — server co-signs).

**Refresh Arkade Script** (4 bytes — checks output is taproot):
```
OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY   // Push output[0]'s [wp, version]
OP_1 OP_EQUALVERIFY                  // Version must be 1 (taproot)
                                     // Stack: [wp] — truthy (non-zero)
```
Bytecode: `00 d1 51 88`

**Why not recursive (input == output)?** Ark's `buildOffchainTx` wraps every input in a 2-leaf checkpoint transaction. The arkTx's `OP_INSPECTINPUTSCRIPTPUBKEY` returns the checkpoint's witness program (2-leaf), not the original VTXO's (3-leaf). Agent enforces same-address output instead.

The refresh leaf uses a DIFFERENT Introspector tweaked key than the claim leaf, because each key is derived from its own Arkade Script: `tweaked_key = base_key + TaggedHash("ArkScriptHash", script) * G`.

### Phase 4: Refresh Cycle via Covenant Leaf (Validated)

Full covenant refresh validated on regtest. The agent spends the claimed 3-leaf VTXO via Leaf 0 (covenant refresh) and creates a new VTXO with the SAME taptree — zero key material used.

**Flow:**
1. Build offchain tx: input = claimed VTXO, output = same pkScript
2. Include OP_RETURN with refresh Arkade Script (`00d15188`)
3. Introspector validates output is taproot → signs with refresh tweaked key
4. arkd validates forfeit closures (Leaf 0 + Leaf 1 both have server pubkey) → co-signs
5. Introspector co-signs arkd's checkpoints → finalize

**Result:** Full Tier 1.5 architecture validated end-to-end on regtest. Agent can:
- Claim incoming VHTLCs with zero key material (covenant claim leaf)
- Refresh VTXOs with zero key material (covenant refresh leaf)
- User retains full custody via collaborative path (alice signs on mobile)

## Reference

- **golem-liquid:** Working reference implementation. Cooperative claim validated on Liquid mainnet, tx `f686839d7bc049e5e146a75536d7ad240c2428fbe90b89472d846fff37926d38`.
- **COVENANT.md:** Three-leaf taptree spec with introspection opcodes (validated on regtest).
- **signer-security.md:** Three-component security model and signer hierarchy.
- **research/keyless-agent-feasibility.md:** Analysis of delegation vs. covenant approaches (agent-state repo).
- **Boltz API:** `/v2/swap/reverse` (create), `/v2/swap/reverse/{id}/claim` (cooperative MuSig2 nonce exchange).
- **boltz-core MuSig2:** `Musig.create()` → `.message()` → `.generateNonce()` → `.aggregateNonces()` → `.initializeSession()` → `.signPartial()` → `.aggregatePartials()`.
- **Introspector:** https://github.com/ArkLabsHQ/introspector — Signing oracle for Arkade Script. Supports 40+ opcodes including all introspection opcodes. Regtest docker-compose available.
- **Arkade hashlock contract:** https://docs.arkadeos.com/contracts/hashlock — Reference implementation for HTLC on Ark with collaborative + unilateral paths.
- **Arkade Script docs:** https://docs.arkadeos.com/contracts/arkade-script — Full opcode reference.
- **Boltz claims docs:** https://api.docs.boltz.exchange/claiming-swaps.html — Cooperative claim API for all supported chains.
- **arkd v0.4 release:** https://github.com/arkade-os/arkd/releases/tag/v0.4.0 — Custom tapscript support, agnostic VtxoScript.
