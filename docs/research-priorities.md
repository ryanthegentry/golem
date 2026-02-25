# Golem — Open Research Priorities (v4)

Questions and investigations identified during red team review that must be resolved before or during Phase 1 development. Ordered by criticality.

---

## P0: Must Answer Before Writing Significant Code

### 1. Delegation Primitive Scope and Semantics
**Status:** RESOLVED (Feb 25, 2026)
**Source:** Red Team C1, M1, S2
**Question:** What exactly can be delegated in the Ark protocol? Can delegation be constrained to "refresh to same owner" (preventing a compromised agent from redirecting funds)? What credential does the delegate receive, and can it be revoked?
**Resolution:** Tiero (Ark Labs) confirmed that delegation is constrained to "refresh to same owner" by protocol design. The owner pre-signs a transaction to themselves; the delegate cannot change the output destination. A compromised agent can only cause denial of service (failing to refresh), NOT fund theft. Collusion risk (delegate + operator) is mitigated by 1-of-N delegation supporting up to 10 delegates — not needed for PoC but available for production.
**Impact:** Security model holds as designed. Agent compromise = DoS only.

### 2. Arkade SDK Signer Abstraction
**Status:** RESOLVED (Feb 25, 2026)
**Source:** Initiation Prompt Step 2
**Question:** Does the Ark Labs Wallet SDK already have a signer interface/abstraction? Does it support external signers? How does it handle PSBT construction?
**Resolution:** Full analysis in `docs/sdk-identity-analysis.md`. SDK uses an `Identity` interface with three methods: `sign(tx)`, `signMessage(msg, type)`, and `signerSession()`. Existing implementations (`SingleKey`, `SeedIdentity`) call `tx.sign(privateKey)` internally — requiring raw key access. GolemIdentity bridge will use PSBT extraction (`tx.toPSBT()` → GolemSigner → `Transaction.fromPSBT()`) to avoid exposing keys. `signMessage()` added to GolemSigner interface. MuSig2 signer sessions use ephemeral random keys (independent of wallet key), so `TreeSignerSession.random()` is fine.

### 3. Boltz + Arkade Testnet Integration
**Status:** RESOLVED (Feb 25, 2026)
**Source:** Red Team P5, F5
**Question:** Does the Boltz-Arkade integration work on mutinynet testnet? What are the swap limits? Is the integration stable enough for a PoC?
**Resolution:** `@arkade-os/boltz-swap@0.2.20` works on mutinynet. API connectivity confirmed via `BoltzSwapProvider` → `ArkadeLightning`. Invoice creation verified (`createLightningInvoice`), swap limits retrievable (`getLimits`), fee schedule queryable (`getFees`). GolemLightning wrapper implemented in `src/lightning/` with full unit test coverage. Full end-to-end flow (paying an invoice and claiming VTXOs) pending manual test with a Lightning wallet, but no blockers found. Boltz API endpoint: `https://api.boltz.mutinynet.arkade.sh`.
**Impact:** Lightning onboarding path is viable for PoC. Primary onboarding friction eliminated.

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
**Question:** What's the minimal Railway template for a Golem agent? What does the /setup wizard collect? How is the delegation credential provisioned?
**Why critical:** This is how non-technical users deploy their agent.
**Action:** Study OpenClaw Railway template (`arjunkomath/openclaw-railway-template`). Design Golem equivalent. Build and test.

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

### 9. Fintech Attorney Consultation
**Status:** Not started
**Source:** Red Team R1, R2, R4
**Question:** Does the user-owned agent model with delegation credentials constitute money transmission? What jurisdictional issues exist?
**Why critical:** Must answer before mainnet launch. Not blocking for testnet PoC.
**Action:** Identify Bitcoin-focused fintech attorneys (e.g., Marco Santori, Gabriel Shapiro, or firms like Anderson Kill, Debevoise). Schedule consultation before Phase 2.

### 10. Tax Reporting Data Requirements
**Status:** Not started
**Source:** Red Team R5
**Question:** What transaction records do users need from day one for tax compliance? Are VTXO refreshes taxable events?
**Why critical:** Users need records even if tax reporting UI ships in Phase 3.
**Action:** Ensure all agent actions are logged with timestamps, amounts, and counterparties. Research whether refreshes constitute taxable events (likely no, but confirm).

---

## Validated via Live Testnet (Feb 25, 2026)

All P0 items resolved with live validation on mutinynet. End-to-end test: faucet → on-chain receive → board into Ark → OOR send 21,000 sats to Tiero (Ark Labs CEO) → balance update → transaction history.

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
