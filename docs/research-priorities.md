# Golem — Open Research Priorities (v5)

Questions and investigations identified during red team review and subsequent development. Ordered by criticality. Updated with delegation deep dive findings (Feb 26, 2026).

---

## P0: Must Answer Before Writing Significant Code

### 1. Delegation Primitive Scope and Semantics
**Status:** PARTIALLY RE-OPENED (Feb 26, 2026)
**Source:** Red Team C1, M1, S2 + SDK audit + delegate branch analysis

**Question:** What exactly can be delegated in the Ark protocol? Can delegation be constrained to "refresh to same owner" (preventing a compromised agent from redirecting funds)? What credential does the delegate receive, and can it be revoked?

**Protocol-level resolution (Feb 25):** Tiero (Ark Labs) confirmed that delegation is constrained to "refresh to same owner" by protocol design. The owner pre-signs a transaction to themselves; the delegate cannot change the output destination. A compromised agent can only cause denial of service (failing to refresh), NOT fund theft. Collusion risk (delegate + operator) is mitigated by 1-of-N delegation supporting up to 10 delegates — not needed for PoC but available for production.

**Implementation status: BUILDING BLOCKS in published SDK, orchestration NOT available.**

The `@arkade-os/sdk@0.3.13` npm package contains the low-level primitives needed for delegation:
- `Intent.create()` — BIP322-style ownership proofs (register + delete message types)
- `buildForfeitTx()` — construct forfeit transactions
- `CLTVMultisigTapscript` — CLTV-locked multisig for delegation tapscript paths
- `VtxoScript` — custom VTXO scripts with multiple tap leaves
- `combineTapscriptSigs()` — combine tapscript signatures from multiple parties

What's **missing** is the high-level delegation orchestration — no `DelegateWallet`, no `delegatedSettle()`, no `DelegatedIdentity`. The `delegate` branch of `arkade-os/ts-sdk` has this orchestration in `examples/delegate.js`, but it hasn't been merged to main or published to npm.

`wallet.settle()` has a single code path with zero delegation branching. All signing goes directly through `this.identity.sign()` with no conditional logic.

**Critical correction to our docs — delegation is NOT a credential you present to the ASP.** It's a set of pre-signed artifacts (intent + partial forfeit TX signed with `SIGHASH_ALL|ANYONECANPAY`) that the delegate submits and completes during the round. The delegate is an active round participant with its own keypair, not a passive credential holder.

**Delegation is per-VTXO, per-cycle.** Each VTXO must be created with a delegation tapscript (`A+D+S` where A=Alice, D=Delegate, S=Server). After each refresh, new VTXOs need new pre-signed intents. This requires the master key to come online once per refresh cycle for provisioning.

**Waiting on:** Tiero's response to "can provisioning cover multiple cycles?" and "when will delegation orchestration ship in published SDK?"

**Impact:** Protocol-level security model holds (refresh-to-same-owner = DoS only). But implementation path is longer than expected — Phase 2, not Phase 1.

### 2. Arkade SDK Signer Abstraction
**Status:** RESOLVED (Feb 25, 2026)
**Source:** Initiation Prompt Step 2
**Question:** Does the Ark Labs Wallet SDK already have a signer interface/abstraction? Does it support external signers? How does it handle PSBT construction?
**Resolution:** Full analysis in `docs/sdk-identity-analysis.md`. SDK uses an `Identity` interface with three methods: `sign(tx)`, `signMessage(msg, type)`, and `signerSession()`. Existing implementations (`SingleKey`, `SeedIdentity`) call `tx.sign(privateKey)` internally — requiring raw key access. GolemIdentity bridge uses PSBT extraction (`tx.toPSBT()` → GolemSigner → `Transaction.fromPSBT()`) to avoid exposing keys. `signMessage()` added to GolemSigner interface. MuSig2 signer sessions use ephemeral random keys (independent of wallet key), so `TreeSignerSession.random()` is fine.

**Additional finding (Feb 26):** SDK also exports `ReadonlySingleKey` and `ReadonlyWallet` for public-key-only read access (balance, VTXOs, history). Validated live — returns correct balance with zero key material.

### 3. Boltz + Arkade Testnet Integration
**Status:** RESOLVED (Feb 25, 2026)
**Source:** Red Team P5, F5
**Question:** Does the Boltz-Arkade integration work on mutinynet testnet? What are the swap limits? Is the integration stable enough for a PoC?
**Resolution:** `@arkade-os/boltz-swap@0.2.20` works on mutinynet. API connectivity confirmed via `BoltzSwapProvider` → `ArkadeLightning`. Invoice creation verified (`createLightningInvoice`), swap limits retrievable (`getLimits`), fee schedule queryable (`getFees`). GolemLightning wrapper implemented in `src/lightning/` with full unit test coverage. End-to-end flow validated with live Lightning payment on mutinynet. Arkade-Boltz gateway minimum swap: 500 sats (not 50,000). Boltz API endpoint: `https://api.boltz.mutinynet.arkade.sh`.

**Additional validation (Feb 26):** Full L402 payment cycle confirmed. Voltage LND → Boltz reverse swap → Golem Ark wallet. 402 challenge in 139ms, LN payment ~1s, L402 token verification 9ms. `golem pay` command pays L402 gateways from Ark wallet via Boltz submarine swap.

---

## P1: Must Answer During Phase 1 Development

### 4. Tapsigner Compatibility with Ark Signing
**Status:** Unresolved
**Source:** Red Team F4
**Question:** Does Tapsigner support the specific signing operations required by Ark (VTXO refresh, delegation credential creation)? Does it work with the Arkade SDK?
**Why critical:** Tapsigner is the default hardware upgrade device. If it's not compatible, need to fall back to Coldcard/Trezor (more expensive, worse UX).
**Action:** Test Tapsigner with Arkade SDK signing operations on testnet. If the SDK uses standard PSBT, Tapsigner should work (it supports PSBT). Verify.

### 5. Tapsigner Fulfillment Without PII Liability
**Status:** Unresolved
**Source:** Red Team F4
**Question:** How can Golem ship complimentary Tapsigners to users at threshold without storing mailing addresses (PII)?
**Options to investigate:**
- Coinkite direct-to-user fulfillment (Golem pays, Coinkite ships, Golem never sees address)
- Gift card / redemption code approach (user redeems on Coinkite's site)
- Third-party fulfillment service with data isolation
**Why critical:** Storing mailing addresses creates a data governance burden and potential liability.
**Action:** Contact Coinkite about fulfillment partnerships. Research gift card options.

### 6. Railway Template Design
**Status:** Pattern validated (OpenClaw), implementation needed
**Source:** Red Team F1
**Question:** What's the minimal Railway template for a Golem agent? What does the /setup wizard collect?
**Why critical:** This is how non-technical users deploy their agent.
**Updated note (Feb 26):** Railway agent will use ServerSigner (Tier 0 hot key, encrypted on disk) for autonomous operation. Delegation-based operation (where the Railway agent acts as a delegate for a mobile wallet) is Phase 2, blocked on SDK delegation orchestration.
**Action:** Study OpenClaw Railway template. Design Golem equivalent. Build and test.

### 7. Pre-Signed Transaction Tree Recovery
**Status:** Unresolved
**Source:** Red Team M3
**Question:** If both the agent and ASP are down, can a user with only their seed phrase reconstruct VTXOs? Or do they need the pre-signed transaction tree data? Where should this data be backed up?
**Why critical:** This determines whether seed-only recovery is possible or whether additional backup is needed.
**Premium tier feature:** Encrypted pre-signed transaction tree backup to user-controlled S3. But the free tier user needs a recovery story too.
**Action:** Research Ark protocol recovery requirements. Document minimum data needed for unilateral exit.

---

## P2: Nice to Have for Phase 1, Required for Phase 2

### 8. Mempool Monitoring for Dynamic Safety Margins
**Status:** Known approach, implementation needed
**Source:** Red Team C5
**Question:** What mempool data sources should the agent use? What's the algorithm for adjusting the refresh safety window?
**Why critical for quality:** Static 48-hour windows are insufficient during fee market events. Dynamic margins are a core differentiator.
**Action:** Research mempool.space API, Bitcoin Core `estimatesmartfee`, and similar. Design algorithm.

### 9a. ServerSigner (Tier 0 Bootstrap Wallet)
**Status:** Design complete, implementation straightforward
**Source:** Red Team (split from original #9)
**Question:** How does the hot key bootstrap signer work for Railway/self-hosted deployments?
**Resolution:** ServerSigner holds a secp256k1 key encrypted on disk (AES-256). Same operational model as current MockSigner but with at-rest encryption. No delegation needed — key is present for all signing operations. This is the immediate next implementation task for production readiness.
**Action:** Implement ServerSigner with AES-256 encryption, key derivation from user password.

### 9b. DelegateIdentity (Post-Sweep Delegation)
**Status:** Blocked on SDK orchestration
**Source:** Red Team + delegation deep dive (Feb 26, 2026)
**Question:** How does the server operate as a delegate after the user sweeps funds to a mobile wallet?
**Significantly more complex than originally scoped.** Requires:
- Own keypair for MuSig2 tree signing participation
- Storage of user's pre-signed intent + tapScriptSig for forfeit TX
- Custom Identity implementation that combines signatures during forfeit TX signing
- VTXO creation with delegation tapscripts (`A+D+S` with CLTV timelock)
- Periodic reprovisioning (master key online once per refresh cycle)

Blocked on delegation orchestration shipping in published SDK (see #13). **This is a Phase 2 task, not Phase 1.**

### 10. Sweep-to-Mobile Flow
**Status:** Design needed, complexity increased
**Source:** Red Team
**Question:** How does a user sweep from Tier 0 hot wallet to a mobile hardware signer?

**New understanding (Feb 26):** After sweep from wallet A (ServerSigner) to wallet B (mobile), the mobile app must create VTXOs with delegation tapscripts (`A+D+S` where D = server's delegate pubkey), sign intents + partial forfeits, and send these to the server. This is a periodic provisioning step (once per refresh cycle). The server then operates as a delegate for those specific VTXOs.

This is more complex than "issue a delegation credential." It requires the mobile app to come online and sign new artifacts each cycle. The UX implications depend on whether provisioning can cover multiple cycles (see #14).

### 11. L402 Gateway Prototype
**Status:** RESOLVED (Feb 26, 2026)
**Source:** Red Team, L402 implementation sessions

**Fully built and security-hardened.** Components:
- `src/l402/macaroon.ts` — `macaroon` npm package (official JS port of Go's `go-macaroon/macaroon`, same library LND/Aperture use). V2 binary serialization.
- `src/l402/gateway.ts` — Hono middleware with per-macaroon root keys, time-before caveats, IP rate limiting.
- `src/l402/gateway-server.ts` — Standalone server with FileRootKeyStore (0600 permissions), security headers.
- `src/cli/commands/pay.ts` — L402 client (`golem pay`) that auto-pays 402 challenges from Ark wallet.

**Security:** Per-macaroon root keys via RootKeyStore, constant-time preimage verification (`crypto.timingSafeEqual`), time-before caveats (300s default TTL), IP rate limiting (30 challenges/min). 35 security tests.

**lnget compatibility validated:** Go's `macaroon.UnmarshalBinary()` successfully deserializes Golem's V2 binary macaroons. lnget parses the 402 challenge, extracts payment hash, creates pending token. Wire-compatible with Lightning Labs ecosystem.

### 12. Fintech Attorney Consultation
**Status:** Not started
**Source:** Red Team R1, R2, R4
**Question:** Does the user-owned agent model with delegation credentials constitute money transmission? What jurisdictional issues exist?
**Why critical:** Must answer before mainnet launch. Not blocking for testnet PoC.
**Action:** Identify Bitcoin-focused fintech attorneys. Schedule consultation before Phase 2.

### 13. Delegation SDK Availability Timeline
**Status:** Blocked — waiting on Ark Labs
**Source:** SDK audit + delegate branch analysis (Feb 26, 2026)
**Question:** When will delegation orchestration (high-level wiring of Intent, buildForfeitTx, CLTVMultisigTapscript, combineTapscriptSigs) ship in the published `@arkade-os/sdk` npm package?

**Why critical:** The low-level primitives exist in the published SDK (v0.3.13), but the orchestration layer (how to wire them for delegated refresh) only exists in `examples/delegate.js` on the unpublished `delegate` branch of `arkade-os/ts-sdk`. Without this, Golem cannot implement the post-sweep delegate flow. The Tier 0 hot key ServerSigner works without delegation, but the upgrade path from Tier 0 → delegated operation is blocked.

**What exists in published SDK:**
| Primitive | Location | Status |
|-----------|----------|--------|
| `Intent.create()` | `intent/index.d.ts` | Exported, usable |
| `buildForfeitTx()` | `forfeit.d.ts` | Exported, usable |
| `CLTVMultisigTapscript` | `script/tapscript.d.ts` | Exported, usable |
| `VtxoScript` | `script/base.d.ts` | Exported, usable |
| `combineTapscriptSigs()` | `utils/arkTransaction.d.ts` | Exported, usable |

**What's missing:** `DelegateWallet`, `delegatedSettle()`, `DelegatedIdentity` — any high-level class or method that wires the primitives into a delegation flow.

**Action:** Track ts-sdk `delegate` branch. Ask Tiero about timeline. Consider building custom orchestration using exported primitives if SDK timeline is too slow.

### 14. Delegation Provisioning Cycle UX
**Status:** Design needed
**Source:** delegate.js example analysis (Feb 26, 2026)
**Question:** How often must the master key come online to provision new delegation intents? Can a single provisioning session create intents for multiple future refresh cycles, or only the next one? How does the mobile app UX handle this?

**Why critical:** If provisioning is required every refresh cycle (~monthly on mainnet), the mobile app must be opened monthly to sign new intents. This is a significant UX constraint. If multiple cycles can be pre-provisioned, the burden drops dramatically.

**UX options to explore:**
- Background provisioning (iOS/Android background task when app is opened for any reason)
- Push notification to "refresh your delegation" when cycle is approaching
- Automatic provisioning when app is opened (silent, no user action needed)
- Multi-cycle pre-provisioning (if protocol supports it)

**Action:** Waiting on Tiero's response. Then design the provisioning UX.

---

## Validated via Live Testnet (Feb 25–26, 2026)

All P0 items resolved with live validation on mutinynet. End-to-end testing covers: wallet creation, boarding, OOR send, VTXO refresh monitoring, L402 gateway with real Lightning payments, and lnget wire compatibility.

| Capability | Status | Notes |
|---|---|---|
| On-chain boarding | Confirmed | Faucet → boarding address → `wallet.onboard()` → settled VTXO |
| OOR send | Confirmed | 21,000 sats sent to Tiero's Ark address, OOR limit enforced |
| Refresh agent monitoring | Confirmed | Polling every 60s, expiry check, consolidation skip logic |
| VTXO consolidation skip | Confirmed | Agent correctly skips consolidation when not needed |
| Transaction history | Confirmed | Sent/received transactions display with correct types and amounts |
| PWA on iPhone | Confirmed | Hono server on atlas behind Tailscale, Add to Home Screen works |
| GolemIdentity bridge | Confirmed | PSBT round-trip signing via MockSigner → GolemIdentity → SDK |
| EventSource polyfill | Confirmed | Required before SDK imports; crashes without it |
| L402 Lightning payment | Confirmed | Voltage LND → Boltz → Golem Ark wallet. 402→pay→200 in ~2s |
| L402 macaroon security | Confirmed | V2 binary, per-key root store, time-before caveats, constant-time verify |
| lnget wire compatibility | Confirmed | Go `macaroon.UnmarshalBinary()` parses Golem macaroons, lnget creates pending token |
| golem pay (L402 client) | Confirmed | Ark wallet → Boltz submarine swap → Lightning → L402 gateway |
| Read-only wallet | Confirmed | `ReadonlySingleKey` + `ReadonlyWallet` returns correct balance with pubkey only |

---

## Resolved During Red Team Process

| Question | Resolution |
|---|---|
| Who is the PoC customer? | Ark Labs (demo protocol viability) + validation for potential company formation |
| Hard block vs. soft cap at threshold? | Hard block. No override. User must withdraw or upgrade hardware. |
| Cloud service vs. user-owned agent? | User-owned. Railway template for deployment. Golem provides software. |
| Neobank branding? | Removed from product docs. Lives in VISION.md only. |
| Swap provider for onboarding? | Boltz. Existing Arkade integration available. |
| Hardware upgrade device? | Tapsigner (~$20 NFC card). Pending compatibility verification. |
| Always-on signer recommendation? | Removed. Physical security nightmare. Use delegation instead. |
| Dashboard scope? | Minimal. Wallet UI, not developer dashboard. |
| Competitive moat vs. Ark Labs? | Open-source + free tier + premium services. Ark Labs wants third parties to build on Arkade. |
| Multi-ASP timeline? | Phase 3. Acceptable single-ASP risk in Phase 1-2. |
| OOR exposure limits? | 10% of total balance or 0.01 BTC, whichever is larger. Configurable. |
| Delegation scope (P0 #1)? | Refresh-to-same-owner by design. Compromised agent = DoS only. Confirmed by Tiero (Feb 25, 2026). |
| SDK signer abstraction (P0 #2)? | SDK uses Identity interface. GolemIdentity bridge wraps GolemSigner via PSBT extraction. See `docs/sdk-identity-analysis.md`. |
| Boltz + Arkade testnet (P0 #3)? | `@arkade-os/boltz-swap@0.2.20` works on mutinynet. Invoice creation, limits, fees all verified. GolemLightning wrapper in `src/lightning/`. |
| Tax reporting data (former #10)? | Ensure all agent actions are logged with timestamps, amounts, and counterparties. Research whether refreshes constitute taxable events (likely no, but confirm with attorney). |
