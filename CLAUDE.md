# Golem

Agent-managed self-custodial Bitcoin wallet on Ark protocol. VTXOs expire on ~4 week timelocks. If users don't refresh, they lose their bitcoin. Golem is an AI agent that automates this.

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
- **Phase 1.5 target:** Covenant-based keyless receive (gated on Arkade introspection opcodes, Ark Labs maintainer timeline: "before this quarter ends" = March 2026). Server NEVER holds a signing key. Claim daemon detects incoming VHTLCs and constructs covenant-valid claim transactions using just the preimage — no signing required.
- **Delegation:** Deferred optimization. SDK building blocks exist but orchestration is missing. Covenant path makes delegation irrelevant for the provider use case. May revisit in Phase 2+ if needed.
- All signing goes through the `GolemSigner` interface. No exceptions.
- Each user deploys their own agent (Railway template or Docker). NOT a shared cloud service.

## Key Distinctions (Get These Right)

- **Arkade Money** = Ark Labs' reference wallet (Go). Their product.
- **Second** = SEPARATE COMPANY, independent Ark implementation in Rust. Different team.
- **Boltz** = Non-custodial swap provider. Existing `@arkade-os/boltz-swap` integration for Lightning↔Ark. Arkade-Boltz gateway minimum: **500 sats** (not 50,000). Fees: 0.01% submarine (LN→Ark), 0.4% reverse (Ark→LN).
- **Tapsigner** = Default hardware upgrade device (~$20 NFC card, secp256k1, PSBT support).
- **other agent wallet** (https://agent-wallet.example/) = Ark Labs maintainer's own agent wallet on Ark. Custodial (Evervault Enclave). No multisig, no covenants, no L402. Same Boltz SwapManager pattern Golem uses. Complementary, not competitive — other agent wallet = custodial convenience, Golem = self-custodial with L402 standard.

## Current Phase: Phase 1 PoC (testnet)

Solo builder. Working testnet wallet with automated refresh for Ark Labs demo.

### Live Testnet Validation (Feb 25–26, 2026)

End-to-end test completed on mutinynet: faucet → on-chain receive → board into Ark → OOR send 21,000 sats to Ark Labs maintainer (Ark Labs CEO). First third-party agent-managed Ark wallet transaction.

**Server startup:** `GOLEM_SIGNER_KEY=<hex> npm start`
**Ryan's testnet key:** `fixture`
**Tests:** 336 passing, zero TypeScript errors
**SDK bugs filed:** arkade-os/ts-sdk#310, #311, #312

### Task Priority

| Step | Task | Status |
|------|------|--------|
| 1 | `GolemSigner` interface + `MockSigner` | DONE |
| 2 | Research: Ark SDK delegation primitive | DONE (P0 resolved) |
| 3 | Research: `@arkade-os/boltz-swap` testnet | DONE (P0 resolved) |
| 4 | Testnet wallet creation + boarding | DONE |
| 5 | VTXO monitoring + refresh agent | DONE |
| 6 | VTXO consolidation during refresh rounds | DONE |
| 7 | OOR settlement + exposure limits | DONE |
| 8 | Safe harbor address setup + emergency exit | DONE |
| 9 | Wallet UI (PWA + API server) | DONE |
| 10 | L402 Lightning-gated reverse proxy | DONE |
| 11 | CLI: init, balance, gateway, stats, pay | DONE |
| 12 | L402 security hardening (V2 macaroons) | DONE |
| 13 | Dual-mode L402 gateway (Lightning + Ark OOR) | DONE |
| 14 | lnget e2e compatibility validation | DONE |
| 15 | Delegation deep dive + SDK audit | DONE (research, delegation deferred) |
| 16 | ServerSigner encryption (AES-256) | DONE |
| 17 | Environment-based network switching | DONE |
| 18 | Time-based macaroon caveats + SQLite store | DONE |
| 19 | L402 internal API (402index contract) | DONE |
| 20 | Pre-mainnet test suite + mainnet smoke test | DONE |
| 21 | Monitoring + Telegram alerts | DONE |
| 22 | Hardening (rate limits, sweep, graceful shutdown) | DONE |
| 22.5 | Telegram dashboard bot (interactive commands) | DONE |
| 23 | Railway template with /setup wizard | TODO |
| 24 | Covenant claim daemon (Phase 1.5) | TODO (gated on Arkade opcodes, March 2026) |
| 25 | `golem directory search` + `golem directory list` CLI commands | DONE |
| 26 | 402Index.io — L402 service directory (separate repo: ~/projects/402index/) | DONE (live) |

### L402 Gateway (Feb 25–26, 2026)

Dual-mode L402 reverse proxy backed by Ark — no LND required. Two payment rails:

- **Lightning path:** Standard `WWW-Authenticate: L402 macaroon=..., invoice=...` via Boltz reverse swaps. Backward compatible with lnget/Aperture.
- **Ark-native path:** Direct OOR payment via `ark_payment` object in 402 response. No Lightning intermediary. Consumer sends sats to provider's Ark address. Gateway detects VTXO, reveals preimage at `/l402/preimage?payment_id=X`. ~1.2s payment confirmation vs ~5-20s via Lightning.

**Components:**
- `src/l402/macaroon.ts` — V2 binary macaroons via `macaroon` npm package (Go macaroon library JS port). Per-macaroon root keys via RootKeyStore, time-before caveats, constant-time preimage verification.
- `src/l402/macaroon-types.d.ts` — TypeScript declarations for the `macaroon` npm package.
- `src/l402/gateway.ts` — Hono middleware: dual-mode 402 challenges + L402 token verification + IP rate limiting + VTXO listener for Ark OOR detection.
- `src/l402/gateway-server.ts` — Standalone server with upstream proxy, FileRootKeyStore, security headers (env-configurable).

**Live test results:** Lightning: Voltage LND → Boltz reverse swap → Ark wallet. Ark OOR: direct VTXO send → gateway detection → preimage reveal. Both rails validated end-to-end on mutinynet. 146 tests (44 security tests, 29 safe harbor tests).

**Liquidity setup for testing:** Keysend (LND→faucet for inbound) → submarine swap (Ark→LND for Boltz ARK liquidity) → reverse swap (LND→Ark for L402 payment). All three directions must have liquidity.

**Known issue:** Boltz mutinynet reverse swaps fail with "onchain coins could not be sent" when Boltz has no ARK liquidity. Fixed by priming Boltz via submarine swap first.

**Service Directory:** 402Index.io (live, separate repo: ~/projects/402index/). Public REST API at https://402index.io/api/v1/services. CLI commands `golem directory search` and `golem directory list` query it directly (no auth required).

### Golem CLI (Feb 26, 2026)

Commander.js CLI with `~/.golem/config.json` persistence. Live-validated end-to-end on mutinynet.

**Commands:**
- `golem init` — Generate wallet, connect to Ark server, save config. `--network`, `--ark-server`, `--force`, `--safe-harbor <address>`.
- `golem balance` — Show total/available/settled/boarding sats + address.
- `golem gateway` — Dual-mode L402 reverse proxy. `--upstream` (required), `--price` (required), `--port`, `--free-paths`, `--no-ark`.
- `golem stats` — Query running gateway's `/stats` endpoint. Shows per-rail breakdown (Lightning vs Ark OOR).
- `golem pay <url>` — L402 client: auto-pays 402 challenges from Ark wallet. `--max-price`, `--method`, `--header`, `--ark` (pay via OOR instead of Lightning).
- `golem safe-harbor` — Show/update safe harbor address. `--set <address>`.
- `golem exit` — Manual emergency exit to safe harbor. Requires "exit" confirmation.
- `golem reserve` — On-chain reserve status (required for unilateral exit).
- `golem directory search <query>` — Search 402Index.io. `--category`, `--protocol`, `--max-price`, `--healthy-only`, `--json`.
- `golem directory list` — List all services from 402Index.io. `--protocol`, `--healthy-only`, `--all`, `--json`.

**Files:** `src/cli/index.ts` (entry), `src/cli/config.ts`, `src/cli/wallet.ts` (shared init), `src/cli/commands/{init,balance,gateway,stats,pay,safe-harbor,exit,reserve,directory}.ts`, `src/directory/client.ts` (402Index API client), `src/cli/cli.test.ts`.

**Usage:** `npm run golem -- <command>` or after build: `npx golem <command>`.

**lnget e2e compatibility (Feb 26, 2026):** Full L402 flow validated end-to-end with lnget CLI. Command: `lnget --max-cost 1100 -q http://localhost:8402/v1/aqi`. lnget parses 402 + WWW-Authenticate → pays Boltz invoice via Voltage LND → retries with L402 Authorization header → gateway returns proxied upstream response. Fixes applied: (1) 66-byte identifier (Aperture `DecodeIdentifier` format — 2 version + 32 payment_hash + 32 token_id with root_key_id in first 4 bytes), (2) Accept `LSAT` prefix in Authorization header (Aperture sends both LSAT and L402 for backward compat). Also patched lnget bug: `ln/lnd.go` maps `"signet"` → `NetworkSimnet` instead of `NetworkSignet`.

### Credentials

Voltage LND macaroon is read from `VOLTAGE_MACAROON` env var (base64-encoded). Never hardcode in source files.

### L402 Security Hardening (Feb 26, 2026)

Replaced custom JSON-based macaroon implementation with `macaroon` npm package (official JS port of Go macaroon library, same as LND/Aperture).

**Security improvements:**
- Per-macaroon root keys via RootKeyStore (MemoryRootKeyStore for testing, FileRootKeyStore with 0600 permissions for production)
- Time-before caveats for replay protection (configurable TTL, default 300s)
- Constant-time preimage verification via `crypto.timingSafeEqual` (library's SJCL bitArray.equal is NOT constant-time)
- V2 binary serialization format (lnget/Aperture compatible)
- IP-based rate limiting on 402 challenge issuance (default 30/min)
- Security headers (X-Content-Type-Options, X-Frame-Options) on all responses

**Known limitation — preimage settlement gap:** Between HTLC settlement (preimage revealed) and the Boltz swap completing into the Ark wallet, there's a brief window where the gateway has verified the preimage but the sats haven't arrived as a VTXO. This is a Boltz swap latency issue, not an L402 vulnerability. The preimage proof-of-payment is valid immediately.

### Covenant-Based Receive (Phase 1.5)

**Target architecture for keyless Lightning receive.** Gated on Arkade introspection opcodes (Ark Labs maintainer timeline: "before this quarter ends" = March 2026).

**The problem:** When the L402 gateway receives a Lightning payment via Boltz reverse swap, claiming the VHTLC requires the wallet's signing key. Without a key on the server, the gateway can issue 402 challenges and detect payment, but can't claim the sats.

**The solution:** A covenant-restricted VHTLC claim script using three Arkade introspection opcodes:
- `OP_INSPECTOUTPUTSCRIPTPUBKEY` (OP_SUCCESS209) — verifies output pays to user's exact taproot address
- `OP_INSPECTOUTPUTVALUE` (OP_SUCCESS207) — verifies output contains correct amount
- `OP_INSPECTNUMOUTPUTS` (OP_SUCCESS213) — constrains transaction to single output

These are the same opcodes Arkade already uses internally for `unroll.hack` shared output scripts. No compiler needed — raw tapscript byte construction, ~50-60 bytes.

**Claim daemon:** A mode of the existing SwapManager/agent. Detects incoming VHTLCs, constructs covenant-valid claim transactions using just the preimage (no signing), submits to ASP. ~2-3 days of CC work once opcodes are live.

**Impact on provider flow (Marcus):** Server NEVER holds a signing key after init. `golem init` generates keypair, shows seed phrase, deletes key from server. Server runs in receive-only mode forever. Mobile app holds the only signing key, handles refresh when user opens it (~monthly). 30-day VTXO expiry = natural onboarding funnel to the mobile app.

**Open questions:** Can the Arkade-Boltz gateway support covenant-restricted VHTLCs? (Awaiting Ark Labs maintainer — this is the remaining Phase 1.5 gating unknown.)

**Resolved:** `createLightningInvoice()` requires only the pubkey, not a signing key. Call chain: `createLightningInvoice()` → `createReverseSwap()` → `wallet.identity.compressedPublicKey()` → pure key derivation. `ReadonlySingleKey` compatible. Boltz creates the invoice server-side. Claiming the VHTLC still requires signing (covenant target).

### Delegation Research (Feb 26, 2026) — DEFERRED

**Status: Delegation is deferred. Covenant-based keyless receive is the Phase 1.5 target.** Delegation becomes irrelevant for the provider use case once covenants ship. "Just refresh from the app" achieves the same outcome as delegation with dramatically less complexity.

SDK audit found: delegation low-level primitives (`Intent`, `buildForfeitTx`, `CLTVMultisigTapscript`, `combineTapscriptSigs`) ARE in published `@arkade-os/sdk@0.3.13`. High-level delegation orchestration is NOT — only on unpublished `delegate` branch of `arkade-os/ts-sdk`.

Read-only wallet works: `ReadonlySingleKey` + `ReadonlyWallet` gives full balance/VTXO/history with pubkey only.

See `docs/research-priorities.md` for full details.

### Mainnet Readiness (Feb 27, 2026)

**Network switching:** `GOLEM_NETWORK=mainnet` selects mainnet URLs (arkade.computer, api.ark.boltz.exchange, mempool.space). All hardcoded mutinynet URLs replaced with `getNetworkConfig()`. Mainnet enforces encryption, safe harbor, and rejects `GOLEM_SIGNER_KEY` env var.

**Key facts:** Mainnet VTXO expiry is 7 days (605184s from arkade.computer/v1/info), NOT 4 weeks. Boltz mainnet minimum: 333 sats reverse swap, 0.25% fee.

**Time-based macaroons:** `MacaroonStore` (SQLite, better-sqlite3) tracks payment_hashes for anti-replay. `expires_at` caveats in HMAC chain prevent tampering. Default: 500 sats = 24h access.

**Internal L402 API:** `golem serve` starts POST /l402/challenge, POST /l402/verify, GET /l402/status on port 8402. Responses use camelCase (`paymentHash`, `expiresAt` as Unix timestamp) for 402index compatibility.

**Monitoring:** Telegram alerts (optional via TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID). Alert thresholds: 48h CRITICAL, 72h WARNING. Balance alerts at >200k and <5k sats.

**CLI additions:** `golem serve`, `golem sweep --keep <sats>`.

**Files:**
- `src/config/networks.ts` — network config map (mainnet/mutinynet/regtest)
- `src/l402/macaroon-store.ts` — SQLite tracking for time-based macaroons
- `src/l402/internal-api.ts` — 402index integration API
- `src/l402/invoice-limiter.ts` — pending invoice rate limiter
- `src/monitoring/alerts.ts` — Telegram + console alerting
- `src/cli/commands/serve.ts` — internal API server
- `src/cli/commands/sweep.ts` — sweep excess to safe harbor
- `docs/mainnet-smoke-test.md` — manual smoke test procedure

### Telegram Dashboard Bot (Feb 28, 2026)

Interactive read-only bot with 5 commands (`/status`, `/txs`, `/vtxos`, `/health`, `/gateway`) and real-time L402 payment notifications. Activates when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set (same env vars as alerts). Long-polling with chat ID allowlist.

**Offset tracking:** Drains stale updates on startup (`offset: -1`), deduplicates by `update_id` Set, `Math.max` ensures offset only advances forward. `onPayment` callback on `GatewayConfig` pushes payment notifications to the chat.

**Files:** `src/telegram/bot.ts`, `src/telegram/formatter.ts`, `src/telegram/types.ts`, `src/telegram/commands/*.ts`

**Wired into:** `golem serve` and `golem gateway` (auto-starts if env vars present). `src/cli/refresh-setup.ts` now returns `eventLog: EventLog<RefreshEvent>` for bot context.

### Next Priorities
1. Railway template with /setup wizard
2. Covenant claim daemon (Phase 1.5, gated on Arkade opcodes)

### Signer Interface (Define First)

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

MockSigner holds keys in memory behind this interface. Production swaps in TapsignerSigner, ColdcardSigner, etc. The boundary is real from day one.

## Tiered Security

- **< 0.21 BTC**: Mobile signer OK (phone key, encrypted in Keychain/Keystore)
- **≥ 0.21 BTC**: Hardware signer required. Hard block on inbound funding. No override.
- Escalating prompts at 80%, 95%, 100% of threshold
- Golem ships free Tapsigner at threshold

**Provider path (Marcus):** Server runs receive-only after init. User imports seed into mobile app. No sweep needed. Server continues receive-only via covenant claim daemon (Phase 1.5).

**Agent path (Jake):** Agent wallet has hot key with spending caps. When balance justifies hardware upgrade, user sweeps to mobile wallet. No delegation credential — mobile app handles refresh directly.

## Code Conventions

- TypeScript preferred
- Read SDK source before writing integration code: `git clone` first, understand abstractions
- All agent actions logged with timestamps
- No key material in logs, env vars, or error messages
- Test on Ark mutinynet testnet

## Design System
For all UI and frontend work, read docs/DESIGN.md before generating code.
Brand assets in assets/brand/

## Reference Docs

Read these when you need deeper context:
- `docs/architecture.md` — Three-component model, signer interface, security model, agent deployment
- `docs/ark-reference.md` — Ark protocol specifics, VTXO lifecycle, rounds, fees, Boltz integration
- `docs/research-priorities.md` — Open questions ordered by criticality
- `docs/vision.md` — Long-term product direction (neobank aspirations, team, market)
- `docs/sdk-identity-analysis.md` — Ark SDK Identity interface analysis, GolemIdentity bridge design
