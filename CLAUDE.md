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
- **Phase 1:** Agent uses ServerSigner (hot key encrypted on disk). Key IS present — same security model as every LN node and other agent wallet (Ark Labs maintainer's agent wallet on Ark). Acceptable and pragmatic for testnet and small mainnet amounts.
- **Phase 1.5 target:** Covenant-based keyless receive (gated on Arkade introspection opcodes). Server NEVER holds a signing key. Claim daemon detects incoming VHTLCs and constructs covenant-valid claim transactions using just the preimage — no signing required.
- All signing goes through the `GolemSigner` interface. No exceptions.
- Each user deploys their own agent (Railway template or Docker). NOT a shared cloud service.

## Key Distinctions (Get These Right)

- **Arkade Money** = Ark Labs' reference wallet (Go). Their product.
- **Second** = SEPARATE COMPANY, independent Ark implementation in Rust. Different team.
- **Boltz** = Non-custodial swap provider. Existing `@arkade-os/boltz-swap` integration for Lightning↔Ark. Arkade-Boltz gateway minimum: **500 sats** (not 50,000). Fees: 0.01% submarine (LN→Ark), 0.4% reverse (Ark→LN).
- **Tapsigner** = Default hardware upgrade device (~$20 NFC card, secp256k1, PSBT support).
- **other agent wallet** (https://agent-wallet.example/) = Ark Labs maintainer's agent wallet on Ark. Custodial (Evervault Enclave). No multisig, no covenants, no L402. other agent wallet is custodial convenience; Golem is self-custodial with L402.

## Current Phase: Phase 1 PoC

Working testnet wallet with automated refresh, dual-mode L402 gateway, and CLI. Live on mutinynet and mainnet. 556 passing tests.

### What's Built
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
2. Rust rewrite (see specs/ directory — 21 spec files defining Cargo workspace)

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

- TypeScript (current). Rust rewrite pending — see specs/ for Cargo workspace design.
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

## Spec Files (Rust Rewrite)

The `specs/` directory contains 21 specification files defining the Rust rewrite:

| Spec | Module | Tests |
|---|---|---|
| 00-overview | Architecture, Cargo workspace, quality gate | — |
| 01-signer | GolemSigner trait, implementations | 24 |
| 02-identity | GolemIdentity bridge to SDK | 8 |
| 03-config | Configuration, network, env | 27 |
| 04-storage | SQLite, file store, migrations | 15 |
| 05-wallet | GolemWallet wrapper, OOR, balance | 53 |
| 06-auth-utils | Macaroon minting, preimage, helpers | 17 |
| 07-lightning | Boltz swaps, GolemLightning | 26 |
| 08-l402 | L402 gateway, proxy, cache, dual-mode | 132 |
| 09-covenant | Covenant VTXO, claim daemon, Introspector | 31 |
| 10-agent | RefreshAgent, tick algorithm, backoff | 42 |
| 11-sweep | Auto-sweep, address resolver, circuit breaker | 40 |
| 12-resilience | Retry, circuit breaker, graceful shutdown | 28 |
| 13-telegram | Bot commands, formatter, alerts | 28 |
| 14-server | HTTP server, API routes, middleware | 35 |
| 15-cli | CLI commands, argument parsing | 28 |
| 16-directory | 402index client, registration | 24 |
| 17-monitoring | Health checks, metrics, alerting | 21 |
| 18-unilateral-exit | Safe harbor, emergency exit paths | — |
| 19-readonly-signer | ReadOnlySigner for pubkey-only ops | — |
| 20-golem-liquid-patterns | Patterns portable from golem-liquid | — |

Quality gate: 499 Rust test equivalents mapped from 581 TS tests. 82-test gap accounted for (framework, mock, integration).

## Reference Docs

Read these when you need deeper context:
- `docs/signer-security.md` — Three-component model, signer interface, security model, agent deployment
- `docs/architecture-overview.md` — Layered architecture, L402 gateway flow diagrams, full test flow
- `docs/ark-reference.md` — Ark protocol specifics, VTXO lifecycle, rounds, fees, Boltz integration
- `docs/research-priorities.md` — Open questions ordered by criticality
- `docs/sdk-identity-analysis.md` — Ark SDK Identity interface analysis, GolemIdentity bridge design
- `docs/COVENANT.md` — Covenant architecture for keyless agent receive
- `docs/RUST-SDK-COMPATIBILITY.md` — 40 API calls mapped TS→Rust, GO verdict
- `docs/PROVIDER-GUIDE.md` — Step-by-step provider onboarding

## Build & Test

```bash
npm install
npm test                    # 556 tests, ~10s
npm run golem -- --help     # CLI
npm run golem -- init       # Create wallet (mutinynet default)
npm run golem -- gateway    # Start L402 gateway
```

## Private Context

Strategic, competitive, and commercial context lives in agent-state (private repo).
CC reads: `~/workspace/agent-state/projects/golem/continuation.md` (session handoff)
CC reads: `~/workspace/agent-state/projects/golem/status.md` (project state)
CC writes: journals, continuation, status Recent Log per `~/workspace/agent-state/CLAUDE.md`

**NEVER write strategic, competitive, pricing, GTM, or business model content
into files in THIS repo.** No code comments referencing business strategy.
No commit messages mentioning negotiation positions or competitive analysis.
Technical facts derived from strategic research are fine (e.g., "dust limit is 330 sats")
but the source/reasoning stays in agent-state.
