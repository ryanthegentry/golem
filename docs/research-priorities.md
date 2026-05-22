# Golem — Open Research Priorities

Questions and investigations identified during security review and subsequent development. Ordered by criticality. Updated with Phase 2 covenant gating questions and new P2 items (March 1, 2026).

---

## P0: Must Answer Before Phase 2 (Covenant Mode)

### 1. Round/Forfeit + Covenant VTXO Compatibility
**Status:** Scheduled for Ark Labs follow-up
**Source:** Roadmap v3 security analysis, March 1, 2026
**Question:** When a covenant VTXO participates in an Ark round, does the forfeit transaction satisfy or violate the recursive covenant? This is THE blocking question for the entire covenant architecture. If the forfeit tx violates the covenant script, VTXOs become unrefreshable — which means covenants and rounds are incompatible, and the entire Phase 2 architecture needs rethinking.
**Action:** Confirm with Ark Labs. If incompatible, evaluate workarounds (e.g., covenant-aware forfeit construction, separate covenant leaf for round participation).

### 2. Arkade Introspection Opcode Ship Date
**Status:** Directional timeline only ("before this quarter ends")
**Source:** Ark Labs discussion, March 1, 2026
**Question:** What is the specific ship date for introspection opcodes exposed to user-constructed scripts? The Arkade VM evaluates these opcodes internally already — when are they exposed for external use? Gates all of Phase 2.
**Action:** Pin down specific date with Ark Labs.

### 3. OP_SUCCESS Semantic Edge Cases
**Status:** Needs research
**Source:** Roadmap v3 security analysis, March 1, 2026
**Question:** Does the Arkade VM ever fall through to Bitcoin's unconditional-success behavior for OP_SUCCESS-prefixed opcodes? If so, the covenant could be bypassed — any spend would be valid. The introspection opcodes (OP_SUCCESS202, OP_SUCCESS207, OP_SUCCESS209, OP_SUCCESS213) MUST fail when their conditions aren't met, not succeed unconditionally.
**Action:** Review Arkade VM source. Test with deliberately invalid covenant transactions.

---

## P0-Resolved: Pre-Phase-1 Items (All Resolved)

### NEW: Covenant VHTLC Boltz Support
**Status:** OPEN — awaiting Ark Labs guidance
**Source:** Session 4 covenant architecture design (Feb 26, 2026)
**Question:** Can the Arkade-Boltz gateway support covenant-restricted VHTLCs? When Boltz creates a reverse swap, can the VHTLC claim script include Arkade introspection opcodes (`OP_INSPECTOUTPUTSCRIPTPUBKEY`, `OP_INSPECTOUTPUTVALUE`, `OP_INSPECTNUMOUTPUTS`) that constrain the claim to pay the user's taproot address?
**Why critical:** This is the lynchpin of the Phase 1.5 keyless receive architecture. If Boltz can't create covenant-restricted VHTLCs, the claim daemon can't work and the server still needs a signing key.
**Action:** Await Ark Labs guidance. If answer is "not yet," determine if this requires Boltz code changes or Arkade gateway changes.

### NEW: Boltz Reverse Swap Signing Requirement
**Status:** RESOLVED (Feb 26, 2026) — `createLightningInvoice()` does NOT require a signing key. Pubkey-only wallet works.
**Source:** Session 4 covenant architecture design (Feb 26, 2026)
**Question:** Does `createLightningInvoice()` (Boltz reverse swap) require the signing key, or just a pubkey? Can a receive-only server create Lightning invoices without holding the wallet's private key?
**Resolution:** Traced the full call chain in `@arkade-os/boltz-swap@0.2.20`:
1. `createLightningInvoice()` → `createReverseSwap()` (boltz-swap/dist/index.js:1535)
2. `createReverseSwap()` calls `this.wallet.identity.compressedPublicKey()` — pure key derivation, no signing (index.js:1630)
3. Sends `{claimPublicKey, preimageHash, invoiceAmount}` to Boltz API (`POST /v2/swap/reverse`) — no signature in request body (index.js:298)
4. Boltz creates the BOLT11 invoice server-side. SDK never creates the invoice.
5. `ReadonlySingleKey.compressedPublicKey()` is a simple property getter (`return this.publicKey`) — fully compatible (sdk/identity/singleKey.js:114)

**Claiming the VHTLC (separate step) DOES require signing:** `claimVHTLC()` wraps identity via `claimVHTLCIdentity()` and calls `identity.sign()` (index.js:1719). This is the step covenant-based claiming would replace in Phase 1.5.

**Impact:** Resolves one of two Phase 1.5 gating unknowns. A pubkey-only server CAN create Lightning invoices for the L402 gateway. The remaining unknown — whether the Arkade-Boltz gateway can support covenant-restricted VHTLCs (P0 #1 above) — is still open. Phase 1.5 feasibility depends on BOTH questions being answered.

### NEW: Safe Harbor Address Design
**Status:** RESOLVED (Feb 26, 2026) — fully implemented
**Source:** Security review, architecture docs
**Resolution:** Safe harbor implemented with two-path fallback: cooperative offboard via `Ramps.offboard()` (ASP required), unilateral unroll via `Unroll.Session` (no ASP needed). RefreshAgent monitors block-based expiry threshold (default 432 blocks / ~72 hours) and triggers emergency exit automatically. On-chain reserve tracking (15,000 sats/VTXO) ensures unilateral exit has fee-bump capacity.

**Implementation:**
- `golem init --safe-harbor <address>` — validates Bitcoin address format + network match
- `golem safe-harbor` — show/update safe harbor address
- `golem exit` — manual emergency exit with confirmation
- `golem reserve` — on-chain reserve status
- `src/wallet/golem-wallet.ts` — `exitToSafeHarbor()` two-path fallback
- `src/agent/refresh-agent.ts` — emergency exit threshold monitoring, consecutive failure tracking
- `src/utils/address-validation.ts` — full checksum + network validation
- 29 safe harbor tests (336 total), zero TypeScript errors

### 1. Delegation Primitive Scope and Semantics
**Status:** DEFERRED (Feb 26, 2026) — Protocol-level resolution holds, but delegation is no longer the target architecture. Covenant-based keyless receive (Phase 1.5) is the path. Delegation becomes relevant only if covenants slip significantly.

**Protocol-level resolution (Feb 25):** Ark Labs confirmed that delegation is constrained to "refresh to same owner" by protocol design. The owner pre-signs a transaction to themselves; the delegate cannot change the output destination. A compromised agent can only cause denial of service (failing to refresh), NOT fund theft.

**Implementation status:** Building blocks in published SDK, orchestration NOT available. The `delegate` branch of `arkade-os/ts-sdk` has orchestration in `examples/delegate.js`, but it hasn't been merged or published.

**Why deferred:** Delegation requires monthly provisioning from the phone. "Just refresh from the app" achieves the same outcome. Covenant path makes delegation irrelevant for the provider use case — the server doesn't need delegation if it never signs.

### 2. Arkade SDK Signer Abstraction
**Status:** RESOLVED (Feb 25, 2026)
**Source:** Initiation Prompt Step 2
**Question:** Does the Ark Labs Wallet SDK already have a signer interface/abstraction? Does it support external signers? How does it handle PSBT construction?
**Resolution:** Full analysis in `docs/sdk-identity-analysis.md`. SDK uses an `Identity` interface with three methods: `sign(tx)`, `signMessage(msg, type)`, and `signerSession()`. Existing implementations (`SingleKey`, `SeedIdentity`) call `tx.sign(privateKey)` internally — requiring raw key access. GolemIdentity bridge uses PSBT extraction (`tx.toPSBT()` → GolemSigner → `Transaction.fromPSBT()`) to avoid exposing keys. `signMessage()` added to GolemSigner interface. MuSig2 signer sessions use ephemeral random keys (independent of wallet key), so `TreeSignerSession.random()` is fine.

**Additional finding (Feb 26):** SDK also exports `ReadonlySingleKey` and `ReadonlyWallet` for public-key-only read access (balance, VTXOs, history). Validated live — returns correct balance with zero key material.

### 3. Boltz + Arkade Testnet Integration
**Status:** RESOLVED (Feb 25, 2026)
**Source:** Security review P5, F5
**Question:** Does the Boltz-Arkade integration work on mutinynet testnet? What are the swap limits? Is the integration stable enough for a PoC?
**Resolution:** `@arkade-os/boltz-swap@0.2.20` works on mutinynet. API connectivity confirmed via `BoltzSwapProvider` → `ArkadeLightning`. Invoice creation verified (`createLightningInvoice`), swap limits retrievable (`getLimits`), fee schedule queryable (`getFees`). GolemLightning wrapper implemented in `src/lightning/` with full unit test coverage. End-to-end flow validated with live Lightning payment on mutinynet. Arkade-Boltz gateway minimum swap: **500 sats** (not 50,000). Fees: 0.01% submarine, 0.4% reverse. Boltz API endpoint: `https://api.boltz.mutinynet.arkade.sh`.

**Additional validation (Feb 26):** Full L402 payment cycle confirmed. Voltage LND → Boltz reverse swap → Golem Ark wallet. 402 challenge in 139ms, LN payment ~1s, L402 token verification 9ms. `golem pay` command pays L402 gateways from Ark wallet via Boltz submarine swap. Ark OOR path also validated: ~1.2s payment confirmation.

---

## P1: Must Answer During Phase 1 Development

### 4. Tapsigner Compatibility with Ark Signing
**Status:** Unresolved
**Source:** Security review F4
**Question:** Does Tapsigner support the specific signing operations required by Ark (VTXO refresh)? Does it work with the Arkade SDK?
**Why critical:** Tapsigner is the default hardware upgrade device. If it's not compatible, need to fall back to Coldcard/Trezor (more expensive, worse UX).
**Action:** Test Tapsigner with Arkade SDK signing operations on testnet. If the SDK uses standard PSBT, Tapsigner should work (it supports PSBT). Verify.

### 5. Tapsigner Fulfillment Without PII Liability
**Status:** Unresolved
**Source:** Security review F4
**Question:** How can Golem ship complimentary Tapsigners to users at threshold without storing mailing addresses (PII)?
**Options to investigate:**
- Coinkite direct-to-user fulfillment (Golem pays, Coinkite ships, Golem never sees address)
- Gift card / redemption code approach (user redeems on Coinkite's site)
- Third-party fulfillment service with data isolation
**Why critical:** Storing mailing addresses creates a data governance burden and potential liability.
**Action:** Contact Coinkite about fulfillment partnerships. Research gift card options.

### 6. Railway Template Design
**Status:** Pattern validated, implementation needed
**Source:** Security review F1
**Question:** What's the minimal Railway template for a Golem agent? What does the /setup wizard collect?
**Why critical:** This is how non-technical users deploy their agent.
**Updated note (Feb 26):** Railway agent will use ServerSigner (Phase 1 hot key, encrypted on disk). Phase 1.5 target is covenant-based receive-only mode where server has no signing key at all.
**Action:** Study comparable Railway templates. Design Golem equivalent. Build and test.

### 7. Pre-Signed Transaction Tree Recovery
**Status:** Unresolved
**Source:** Security review M3
**Question:** If both the agent and ASP are down, can a user with only their seed phrase reconstruct VTXOs? Or do they need the pre-signed transaction tree data? Where should this data be backed up?
**Why critical:** This determines whether seed-only recovery is possible or whether additional backup is needed.
**Premium tier feature:** Encrypted pre-signed transaction tree backup to user-controlled S3. But the free tier user needs a recovery story too.
**Action:** Research Ark protocol recovery requirements. Document minimum data needed for unilateral exit.

### 8. Golem Service Directory Design
**Status:** Concept validated in storyboard, design needed
**Source:** Product planning, feature priority #5
**Question:** What is the minimum viable directory? Data model? Auto-registration flow from `golem gateway`? Agent auto-discovery mechanics? Search API design?
**Why critical:** Without the directory, the L402 economy is dark — agents can't find APIs. The directory creates the network effects that turn Golem from a tool into a platform. First mover advantage is significant.
**Scope:** Phase 1 = centralized (Golem-operated REST API + web UI). Phase 3 = decentralized (Nostr federation).
**Action:** Design data model, REST API, auto-registration flow, search API, web UI. Build MVP.

---

## P2: Nice to Have for Phase 1, Required for Phase 2

### 9. Mempool Monitoring for Dynamic Safety Margins
**Status:** Known approach, implementation needed
**Source:** Security review C5
**Question:** What mempool data sources should the agent use? What's the algorithm for adjusting the refresh safety window?
**Why critical for quality:** Static 48-hour windows are insufficient during fee market events. Dynamic margins are a core differentiator.
**Action:** Research mempool.space API, Bitcoin Core `estimatesmartfee`, and similar. Design algorithm.

### 10a. ServerSigner (Tier 0 Bootstrap Wallet)
**Status:** Design complete, implementation straightforward
**Source:** Security review (split from original #9)
**Question:** How does the hot key bootstrap signer work for Railway/self-hosted deployments?
**Resolution:** ServerSigner holds a secp256k1 key encrypted on disk (AES-256). Same operational model as current MockSigner but with at-rest encryption. No delegation needed — key is present for all signing operations. Same security model as every LN node.
**Action:** Implement ServerSigner with AES-256 encryption, key derivation from user password.

### 10b. DelegateIdentity (Post-Sweep Delegation)
**Status:** DEFERRED — Covenant path eliminates the need for delegation on the receive side. "Just refresh from the app" handles the spend side.

Previously blocked on SDK orchestration. Now irrelevant for the target architecture. Delegation requires monthly provisioning from the phone anyway, so it adds complexity without benefit over the covenant + mobile app approach.

### 11. Sweep-to-Mobile Flow
**Status:** Simplified by covenant architecture
**Source:** Security review

**Provider path (Marcus):** No sweep needed. Server runs receive-only after init. User imports seed into mobile app. Server continues receive-only via covenant claim daemon (Phase 1.5).

**Agent path (Jake):** Agent wallet has hot key with spending caps. When balance justifies, user sweeps to mobile wallet. No delegation credential needed — mobile app handles refresh directly.

### 12. L402 Gateway Prototype
**Status:** RESOLVED — Fully built, dual-mode (Lightning + Ark-native OOR), security hardened. 336 tests. lnget wire compatible.
**Source:** Security review and L402 implementation sessions (Feb 25–26, 2026)

**Components:**
- `src/l402/macaroon.ts` — `macaroon` npm package (official JS port of Go's `go-macaroon/macaroon`, same library LND/Aperture use). V2 binary serialization.
- `src/l402/gateway.ts` — Hono middleware with dual-mode 402 challenges (Lightning + Ark OOR), per-macaroon root keys, time-before caveats, IP rate limiting, VTXO listener for OOR detection.
- `src/l402/gateway-server.ts` — Standalone server with FileRootKeyStore (0600 permissions), security headers.
- `src/cli/commands/pay.ts` — L402 client (`golem pay`) that auto-pays 402 challenges from Ark wallet via Lightning or Ark OOR.

**Security:** Per-macaroon root keys via RootKeyStore, constant-time preimage verification (`crypto.timingSafeEqual`), time-before caveats (300s default TTL), IP rate limiting (30 challenges/min). 44 security tests.

**Dual-mode validated:** Lightning path (Voltage LND → Boltz → Ark) and Ark OOR path (direct VTXO send → gateway VTXO listener detection → preimage reveal) both working end-to-end on mutinynet.

**lnget end-to-end validated (Feb 26, 2026):** Full L402 flow confirmed with lnget CLI against Golem gateway on mutinynet. lnget parses 402 + WWW-Authenticate header, pays Boltz invoice via Voltage LND, receives preimage, retries with Authorization header, gateway returns proxied upstream response. Two fixes required: (1) Golem identifier padded to 66 bytes (Aperture's `DecodeIdentifier` format), (2) Gateway accepts `LSAT` prefix in Authorization header (Aperture sends both LSAT and L402 for backward compat). Also patched lnget signet→simnet mapping bug in `ln/lnd.go`. Exact command: `lnget --max-cost 1100 -q http://localhost:8402/v1/aqi`

### 13. Fintech Attorney Consultation
**Status:** Not started
**Source:** Security review R1, R2, R4
**Question:** Does the user-owned agent model constitute money transmission? What jurisdictional issues exist?
**Why critical:** Must answer before mainnet launch. Not blocking for testnet PoC.
**Action:** Identify Bitcoin-focused fintech attorneys. Schedule consultation before Phase 2.

### 14. Delegation SDK Availability Timeline
**Status:** DEFERRED — No longer blocking. Covenant path is the target architecture.

The low-level primitives exist in the published SDK (v0.3.13), but the orchestration layer only exists on the unpublished `delegate` branch. This no longer matters for Golem's roadmap — delegation is deferred in favor of covenants.

### 15. Delegation Provisioning Cycle UX
**Status:** DEFERRED — Irrelevant if covenants ship. "Just refresh from the app" is the answer.

Delegation requires monthly provisioning from the phone, making its UX burden equivalent to just refreshing from the app directly. The covenant path eliminates the need for delegation entirely on the receive side.

### 16. Pika Integration Architecture
**Status:** Open design question
**Source:** March 1, 2026 — Ben Carman and Justin Moon are building Pika (Nostr-based encrypted agent messaging)
**Question:** How do Pika and Golem fit together? Options: (a) Pika replaces Telegram for monitoring, (b) Pika is mobile app for send, (c) separate products under one company, (d) Golem is infrastructure that Pika integrates as client.
**Note:** Meeting devs where they are (Telegram) matters. Pika shouldn't replace Telegram for human-to-agent monitoring.
**Action:** Discuss at Ben/Justin meeting.

### 17. Stablecoin Integration Planning
**Status:** Not started
**Source:** March 1, 2026
**Question:** What does stablecoin support look like in Golem? Fuji (BTC-backed stablecoin) shipping in weeks. USDT0 team close to Ark Labs. Taproot Assets supported for major stablecoin issuance. Biggest TAM expansion catalyst.
**Action:** Research Fuji and Taproot Assets integration paths. Determine SDK support requirements.

### 18. Mainnet ASP Uptime and Reliability
**Status:** Unknown
**Source:** March 1, 2026
**Question:** What is arkade.computer's actual uptime history? With 7-day VTXO expiry on mainnet, a multi-day ASP outage = fund loss risk for users who can't unilaterally exit in time. Single point of failure until multi-ASP support (Phase 3).
**Action:** Ask Ark Labs for uptime data. Set up independent monitoring. Design alerting for ASP unreachability.

### 19. Regulatory Requirements for L402 Gateway
**Status:** Not started
**Source:** March 1, 2026
**Question:** Does the L402 gateway model constitute money transmission? The gateway receives Lightning payments and converts them to Ark VTXOs. Samourai precedent implications for non-custodial infrastructure operators. Must answer before mainnet launch with real users.
**Action:** Identify Bitcoin-focused fintech attorneys. Consolidate with #13 (Fintech Attorney Consultation).

---

## Demoted / Deferred Concepts

Concepts that were actively explored and consciously deprioritized:

| Concept | Status | Rationale |
|---------|--------|-----------|
| Delegation (DelegateIdentity) | Deferred to Phase 2+ | Covenant path eliminates the need. Monthly provisioning = same UX burden as "just refresh from the app." |
| 2-of-2 Multisig | Validated, deferred | More complex than covenants (still puts a key on server). Remains fallback if covenants slip. |
| Golem Swap Server | Rejected | Covenants solve the problem natively. No need for a custom intermediary. |
| Delegation SDK Timeline (#14) | Deferred | No longer blocking. Not tracking. |
| Delegation Provisioning UX (#15) | Deferred | Moot if covenants ship. |
| Golem Service Directory | Deferred to Phase 3 | 402index.io serves this function for now. Internal directory deferred. |

---

## Validated via Live Testnet (Feb 25–26, 2026)

All P0 items resolved with live validation on mutinynet. End-to-end testing covers: wallet creation, boarding, OOR send, VTXO refresh monitoring, L402 gateway with real Lightning and Ark OOR payments, and lnget wire compatibility.

| Capability | Status | Notes |
|---|---|---|
| On-chain boarding | Confirmed | Faucet → boarding address → `wallet.onboard()` → settled VTXO |
| OOR send | Confirmed | OOR limit enforced |
| Refresh agent monitoring | Confirmed | Polling every 60s, expiry check, consolidation skip logic |
| VTXO consolidation skip | Confirmed | Agent correctly skips consolidation when not needed |
| Transaction history | Confirmed | Sent/received transactions display with correct types and amounts |
| PWA on iPhone | Confirmed | Hono server on the development machine, Add to Home Screen works |
| GolemIdentity bridge | Confirmed | PSBT round-trip signing via MockSigner → GolemIdentity → SDK |
| EventSource polyfill | Confirmed | Required before SDK imports; crashes without it |
| L402 Lightning payment | Confirmed | Voltage LND → Boltz → Golem Ark wallet. 402→pay→200 in ~2s |
| L402 Ark OOR payment | Confirmed | Direct OOR → VTXO listener detection → preimage reveal. ~1.2s confirmation |
| L402 macaroon security | Confirmed | V2 binary, per-key root store, time-before caveats, constant-time verify |
| lnget e2e compatibility | Confirmed | Full L402 flow: lnget parses 402 → pays Boltz invoice via LND → retries with preimage → gets upstream response. Fixes: 66-byte identifier, LSAT prefix support. |
| Safe harbor exit | Confirmed | Two-path fallback (offboard/unroll), emergency threshold monitoring, on-chain reserve tracking. 29 tests. |
| golem pay (L402 client) | Confirmed | Lightning: Ark → Boltz submarine swap → Lightning → L402 gateway. OOR: direct Ark send |
| Read-only wallet | Confirmed | `ReadonlySingleKey` + `ReadonlyWallet` returns correct balance with pubkey only |
| L402 settlement latency | Confirmed | 402 challenge: 139ms. LN payment: ~1s. L402 verification: 9ms. Ark OOR: ~1.2s total. |
| Boltz Arkade-Gateway minimums | Confirmed | 500 sats minimum (not 50,000). 0.01% submarine, 0.4% reverse. |
| Covenant script specification | Confirmed | Three opcodes (209, 207, 213). ~50-60 bytes tapscript. Same as `unroll.hack`. |
| Boltz reverse swap signing | Confirmed | `createLightningInvoice()` needs pubkey only, no signing. `ReadonlySingleKey` compatible. Claiming VHTLC still requires signing (covenant target). |

---

## Resolved During Security Review

| Question | Resolution |
|---|---|
| Who is the PoC customer? | Ark Labs (demo protocol viability) + validation for potential company formation |
| Hard block vs. soft cap at threshold? | Hard block. No override. User must withdraw or upgrade hardware. |
| Cloud service vs. user-owned agent? | User-owned. Railway template for deployment. Golem provides software. |
| Neobank branding? | Removed from product docs. Lives in VISION.md only. |
| Swap provider for onboarding? | Boltz. Existing Arkade integration available. |
| Hardware upgrade device? | Tapsigner (~$20 NFC card). Pending compatibility verification. |
| Always-on signer recommendation? | Removed. Physical security nightmare. |
| Dashboard scope? | Minimal. Wallet UI, not developer dashboard. |
| Competitive moat vs. Ark Labs? | Open-source + free tier + premium services. Ark Labs wants third parties to build on Arkade. |
| Multi-ASP timeline? | Phase 3. Acceptable single-ASP risk in Phase 1-2. |
| OOR exposure limits? | 10% of total balance or 0.01 BTC, whichever is larger. Configurable. |
| Delegation scope (P0 #1)? | Refresh-to-same-owner by design. Compromised agent = DoS only. Confirmed by Ark Labs (Feb 25, 2026). |
| SDK signer abstraction (P0 #2)? | SDK uses Identity interface. GolemIdentity bridge wraps GolemSigner via PSBT extraction. See `docs/sdk-identity-analysis.md`. |
| Boltz + Arkade testnet (P0 #3)? | `@arkade-os/boltz-swap@0.2.20` works on mutinynet. Invoice creation, limits, fees all verified. GolemLightning wrapper in `src/lightning/`. |
| Tax reporting data (former #10)? | Ensure all agent actions are logged with timestamps, amounts, and counterparties. Research whether refreshes constitute taxable events (likely no, but confirm with attorney). |
| Golem swap server concept? | Rejected. Covenants solve the problem natively. |
| Covenant validation? | Directional confirmation from Ark Labs. Implementation details still need confirmation. (Mar 1, 2026) |
| Recursive covenant feasibility? | OP_INSPECTINPUTSCRIPTPUBKEY (202) + OP_INSPECTOUTPUTSCRIPTPUBKEY (209) confirmed in published Arkade Script docs. (Mar 1, 2026) |
| x402 competitive landscape? | 12K+ endpoints, ~500K payments/week, Coinbase/Cloudflare backing. Stablecoin-first. Different trust model. (Feb 27) |
| Boltz Arkade mainnet API URL? | `https://api.ark.boltz.exchange` (confirmed via Ark Labs guidance + live API). (Feb 27) |
| Mainnet swap minimums? | 333 sats reverse, 333 sats submarine, 0.25% fee, zero miner fee. (Feb 27) |
| Mainnet VTXO expiry? | 7 days (not 4 weeks). Boarding exit: 90 days. (Feb 27) |
| SDK mainnet support? | @arkade-os/sdk v0.3.13 handles bitcoin network. Boltz-swap needs explicit apiUrl. (Feb 27) |
| ServerSigner encryption? | Built. AES-256-GCM, scrypt N=2^17, async for servers, sync for CLI. 336 tests. (Feb 26) |
| lnget compatibility? | Tested. Three bugs found and fixed. 66-byte identifier, LSAT prefix, signet mapping. (Feb 26) |
| Safe harbor design? | Built. Cooperative offboard + unilateral fallback. 29 tests. (Feb 26) |
