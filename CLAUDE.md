# Golem

Agent-managed self-custodial Bitcoin wallet on Ark protocol. VTXOs expire on protocol-defined timelocks (7 days mainnet, ~4 weeks testnet). If users don't refresh, they lose their bitcoin. Golem is an AI agent that automates this.

## Architecture (Non-Negotiable)

Three components. Never violate these boundaries.

```
SIGNER (keys)              AGENT (logic)              STATE (data)
Mobile or hardware key     User-owned service         Arkade / ASP
Signs transactions         Proposes transactions      VTXO ownership
NEVER in agent memory      Claim daemon (covenant,    Round history
                           no key) or hot key
                           (Phase 1, spending caps)
```

- Agent NEVER holds master private keys in production. Not in memory. Not temporarily. Not in logs.
- **Phase 1:** Agent uses ServerSigner (hot key encrypted on disk). Key IS present — same security model as every LN node and other agent wallet (Ark Labs maintainer's own agent wallet on Ark). Acceptable and pragmatic for testnet and small mainnet amounts.
- **Phase 1.5 target:** Covenant-based keyless receive (gated on Arkade introspection opcodes). Server NEVER holds a signing key. Claim daemon detects incoming VHTLCs and constructs covenant-valid claim transactions using just the preimage — no signing required.
- All signing goes through the `GolemSigner` interface. No exceptions.
- Each user deploys their own agent (Railway template or Docker). NOT a shared cloud service.

## Key Distinctions (Get These Right)

- **Arkade Money** = Ark Labs' reference wallet (Go). Their product.
- **Second** = SEPARATE COMPANY, independent Ark implementation in Rust. Different team.
- **Boltz** = Non-custodial swap provider. Existing `@arkade-os/boltz-swap` integration for Lightning↔Ark. Arkade-Boltz gateway minimum: **500 sats** (not 50,000). Fees: 0.01% submarine (LN→Ark), 0.4% reverse (Ark→LN).
- **Tapsigner** = Default hardware upgrade device (~$20 NFC card, secp256k1, PSBT support).
- **other agent wallet** (https://agent-wallet.example/) = Ark Labs maintainer's own agent wallet on Ark. Custodial (Evervault Enclave). No multisig, no covenants, no L402. Complementary, not competitive — other agent wallet = custodial convenience, Golem = self-custodial with L402 standard.

## Current Phase: Phase 1 PoC

Working testnet wallet with automated refresh, dual-mode L402 gateway, and CLI. Live on mutinynet and mainnet. 556 passing tests.

### What's Built (Phase 2)
- L402 gateway on mainnet (Railway), dual-mode Lightning + Ark OOR
- `golem gateway init` with auto-discovery + `golem.yaml` config
- Auto-registration with 402index.io on gateway start
- Response caching (configurable TTL, price discount for cache hits)
- Post-auth method validation (GOLEM_UPSTREAM_METHOD)
- Macaroon interop validated (JS V2 binary ↔ Go V2 binary)
- Telegram dashboard bot (/status, /txs, /vtxos, /health, /gateway)
- Auto-sweep to Lightning Address (threshold, keep, minSweep, circuit breaker, graceful shutdown)
- Provider onboarding guide (docs/PROVIDER-GUIDE.md)

### Next Priorities
1. Covenant claim daemon (Phase 1.5, gated on Arkade opcodes — testnet April per Ark Labs maintainer)

## Signer Interface

```typescript
interface GolemSigner {
  getSignerInfo(): Promise<SignerInfo>;
  getPublicKey(): Promise<Buffer>;
  signTransaction(unsignedTx: UnsignedTransaction): Promise<SignedTransaction>;
  ping(): Promise<SignerStatus>;
}
```

**Implementation hierarchy:**
```
GolemSigner (interface)
├── MobileSigner (Tier 1: phone, biometric-gated, THE master key for providers)
├── HardwareSigner (Tier 2: Tapsigner/Coldcard, ≥0.21 BTC)
├── AgentSigner (hot key, spending caps, agent wallets only)
├── ServerSigner (Phase 1: bootstrap hot key for providers before covenants ship)
├── MockSigner (testing)
└── [DelegateIdentity — deferred, Phase 2+ if ever needed]
```

## Tiered Security

- **< 0.21 BTC**: Mobile signer OK (phone key, encrypted in Keychain/Keystore)
- **≥ 0.21 BTC**: Hardware signer required. Hard block on inbound funding. No override.
- Escalating prompts at 80%, 95%, 100% of threshold

## Code Conventions

- TypeScript preferred
- Read SDK source before writing integration code: `git clone` first, understand abstractions
- All agent actions logged with timestamps
- No key material in logs, env vars, or error messages
- Test on Ark mutinynet testnet

## Bug Fix Protocol

When fixing a bug:
1. FIRST write a failing test that reproduces the bug exactly
2. Verify the test fails for the right reason
3. Fix the bug with the minimum change required
4. Verify the test now passes
5. Run the full test suite to confirm no regressions

Never skip step 1. If you can't write a failing test, the bug isn't well-enough understood to fix.

## Reference Docs

Read these when you need deeper context:
- `docs/signer-security.md` — Three-component model, signer interface, security model, agent deployment
- `docs/architecture-overview.md` — Layered architecture, L402 gateway flow diagrams, full test flow
- `docs/ark-reference.md` — Ark protocol specifics, VTXO lifecycle, rounds, fees, Boltz integration
- `docs/research-priorities.md` — Open questions ordered by criticality
- `docs/vision.md` — Long-term product direction, market, team
- `docs/sdk-identity-analysis.md` — Ark SDK Identity interface analysis, GolemIdentity bridge design
- `docs/COVENANT.md` — Covenant architecture for keyless agent receive
