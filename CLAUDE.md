# Golem

Agent-managed self-custodial Bitcoin wallet on Ark protocol. VTXOs expire on ~4 week timelocks. If users don't refresh, they lose their bitcoin. Golem is an AI agent that automates this.

## Architecture (Non-Negotiable)

Three components. Never violate these boundaries.

```
SIGNER (keys)              AGENT (logic)              STATE (data)
Mobile or hardware key     User-owned service         Arkade / ASP
Signs transactions         Proposes transactions      VTXO ownership
NEVER in agent memory      Holds delegation cred      Round history
                           (refresh-scoped ONLY)
```

- Agent NEVER holds master private keys. Not in memory. Not temporarily. Not in logs.
- **Phase 1 (Tier 0):** Agent uses ServerSigner (hot key encrypted on disk). Key IS present — acceptable for small testnet amounts.
- **Phase 2 (delegation):** Agent holds delegate keypair + user's pre-signed artifacts (intent + partial forfeit). NOT a passive credential — delegate actively participates in rounds. Blocked on SDK orchestration layer.
- All signing goes through the `GolemSigner` interface. No exceptions.
- Each user deploys their own agent (Railway template or Docker). NOT a shared cloud service.

## Key Distinctions (Get These Right)

- **Arkade Money** = Ark Labs' reference wallet (Go). Their product.
- **Second** = SEPARATE COMPANY, independent Ark implementation in Rust. Different team.
- **Boltz** = Non-custodial swap provider. Existing `@arkade-os/boltz-swap` integration for Lightning→Ark onboarding.
- **Tapsigner** = Default hardware upgrade device (~$20 NFC card, secp256k1, PSBT support).

## Current Phase: Phase 1 PoC (testnet)

Solo builder. Working testnet wallet with automated refresh for Ark Labs demo.

### Live Testnet Validation (Feb 25, 2026)

End-to-end test completed on mutinynet: faucet → on-chain receive → board into Ark → OOR send 21,000 sats to Tiero (Ark Labs CEO). First third-party agent-managed Ark wallet transaction.

**Server startup:** `GOLEM_SIGNER_KEY=<hex> npm start`
**Ryan's testnet key:** `e0f60aacd061005ae3e59d0540af2caafbcb895212c180c2c1b8813a49d61d1e`
**Tests:** 108 passing, zero TypeScript errors
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
| 8 | Safe harbor address setup + emergency exit | TODO |
| 9 | Wallet UI (PWA + API server) | DONE |
| 10 | L402 Lightning-gated reverse proxy | DONE |
| 11 | CLI: init, balance, gateway, stats | DONE |
| 12 | CLI: golem pay (L402 client) | DONE |
| 13 | L402 security hardening (V2 macaroons) | DONE |
| 14 | Delegation deep dive + SDK audit | DONE (research) |
| 15 | lnget wire compatibility validation | DONE |
| 16 | Railway template with /setup wizard | TODO |

### L402 Gateway (Feb 25–26, 2026)

L402 reverse proxy backed by Ark via Boltz swaps — no LND required. Verified with real Lightning payment on mutinynet.

**Components:**
- `src/l402/macaroon.ts` — V2 binary macaroons via `macaroon` npm package (Go macaroon library JS port). Per-macaroon root keys via RootKeyStore, time-before caveats, constant-time preimage verification. 35 security tests.
- `src/l402/macaroon-types.d.ts` — TypeScript declarations for the `macaroon` npm package.
- `src/l402/gateway.ts` — Hono middleware: 402 challenges + L402 token verification + IP rate limiting.
- `src/l402/gateway-server.ts` — Standalone server with upstream proxy, FileRootKeyStore, security headers (env-configurable).

**Live test result:** Voltage LND → Boltz reverse swap → Ark wallet. Preimage returned in 1s. Macaroon + preimage verified. Status 200 + upstream data.

**Liquidity setup for testing:** Keysend (LND→faucet for inbound) → submarine swap (Ark→LND for Boltz ARK liquidity) → reverse swap (LND→Ark for L402 payment). All three directions must have liquidity.

**Known issue:** Boltz mutinynet reverse swaps fail with "onchain coins could not be sent" when Boltz has no ARK liquidity. Fixed by priming Boltz via submarine swap first.

### Golem CLI (Feb 26, 2026)

Commander.js CLI with `~/.golem/config.json` persistence. Live-validated end-to-end on mutinynet.

**Commands:**
- `golem init` — Generate wallet, connect to Ark server, save config. `--network`, `--ark-server`, `--force`.
- `golem balance` — Show total/available/settled/boarding sats + address.
- `golem gateway` — L402 reverse proxy. `--upstream` (required), `--price` (required), `--port`, `--free-paths`.
- `golem stats` — Query running gateway's `/stats` endpoint.
- `golem pay <url>` — L402 client: auto-pays 402 challenges from Ark wallet via Boltz submarine swap. `--max-price`, `--method`, `--header`.

**Files:** `src/cli/index.ts` (entry), `src/cli/config.ts`, `src/cli/wallet.ts` (shared init), `src/cli/commands/{init,balance,gateway,stats,pay}.ts`, `src/cli/cli.test.ts` (7 tests).

**Usage:** `npm run golem -- <command>` or after build: `npx golem <command>`.

**lnget compatibility:** Protocol flow and V2 binary macaroon format are now compatible with lnget/Aperture. Same `macaroon` npm package as LND ecosystem.

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

### Delegation Research (Feb 26, 2026)

SDK audit found: delegation low-level primitives (`Intent`, `buildForfeitTx`, `CLTVMultisigTapscript`, `combineTapscriptSigs`) ARE in published `@arkade-os/sdk@0.3.13`. High-level delegation orchestration is NOT — only on unpublished `delegate` branch of `arkade-os/ts-sdk`.

Delegation is NOT a credential you present to the ASP. It's pre-signed artifacts (BIP322 intent + partial forfeit TX with `SIGHASH_ALL|ANYONECANPAY`) that the delegate submits and completes during the round. The delegate needs its own keypair and is an active MuSig2 round participant.

Read-only wallet works: `ReadonlySingleKey` + `ReadonlyWallet` gives full balance/VTXO/history with pubkey only.

See `docs/research-priorities.md` #1, #13, #14 for full details.

### Next Priorities
1. ServerSigner (Tier 0 encrypted hot key for Railway)
2. Safe harbor address registration
3. Railway template with /setup wizard
4. Transaction detail view (expand row → full txid, timestamp, type, status)
5. Consider: HTTPS via `tailscale cert` for proper PWA + clipboard

### Signer Interface (Define First)

```typescript
interface GolemSigner {
  getSignerInfo(): Promise<SignerInfo>;
  getPublicKey(): Promise<Buffer>;
  signTransaction(unsignedTx: UnsignedTransaction): Promise<SignedTransaction>;
  getDelegationCredential?(): Promise<DelegationCredential>;
  ping(): Promise<SignerStatus>;
}
```

MockSigner holds keys in memory behind this interface. Production swaps in TapsignerSigner, ColdcardSigner, etc. The boundary is real from day one.

## Tiered Security

- **< 0.21 BTC**: Mobile signer OK (phone key, encrypted in Keychain/Keystore)
- **≥ 0.21 BTC**: Hardware signer required. Hard block on inbound funding. No override.
- Escalating prompts at 80%, 95%, 100% of threshold
- Golem ships free Tapsigner at threshold

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
