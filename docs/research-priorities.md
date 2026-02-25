# Golem — Open Research Priorities (v4)

Questions and investigations identified during red team review that must be resolved before or during Phase 1 development. Ordered by criticality.

---

## P0: Must Answer Before Writing Significant Code

### 1. Delegation Primitive Scope and Semantics
**Status:** Unresolved
**Source:** Red Team C1, M1, S2
**Question:** What exactly can be delegated in the Ark protocol? Can delegation be constrained to "refresh to same owner" (preventing a compromised agent from redirecting funds)? What credential does the delegate receive, and can it be revoked?
**Why critical:** The entire security model depends on this. If delegation is broad (can refresh to arbitrary destinations), the "compromised agent can't steal funds" claim is false. If delegation is narrow (refresh to same owner only), the security model holds.
**Action:** Read Ark Labs SDK source code. Test delegation on testnet. If unclear, ask Tiero directly.
**Updates security model:** Yes — the security model table in Project Instructions must be updated once this is answered.

### 2. Arkade SDK Signer Abstraction
**Status:** Unresolved
**Source:** Initiation Prompt Step 2
**Question:** Does the Ark Labs Wallet SDK already have a signer interface/abstraction? Does it support external signers? How does it handle PSBT construction?
**Why critical:** If the SDK has its own signer interface, `GolemSigner` should wrap it rather than replace it. If the SDK assumes embedded keys, we need to design the separation layer.
**Action:** `git clone` the SDK repo, read the signing-related source files, document findings.

### 3. Boltz + Arkade Testnet Integration
**Status:** Partially resolved — `@arkade-os/boltz-swap` exists
**Source:** Red Team P5, F5
**Question:** Does the Boltz-Arkade integration work on mutinynet testnet? What are the swap limits? Is the integration stable enough for a PoC?
**Why critical:** This is the primary onboarding flow. If it doesn't work, users can't get BTC into Golem without on-chain boarding (much higher friction).
**Action:** `npm install @arkade-os/boltz-swap`, test on mutinynet, document results.

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
