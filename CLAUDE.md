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
- Agent DOES hold a minimally-scoped delegation credential for refresh operations only.
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
**Tests:** 93 passing, zero TypeScript errors
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
| 13 | Railway template with /setup wizard | TODO |

### L402 Gateway (Feb 25–26, 2026)

L402 reverse proxy backed by Ark via Boltz swaps — no LND required. Verified with real Lightning payment on mutinynet.

**Components:**
- `src/l402/macaroon.ts` — Zero-dependency L402 macaroon (HMAC-SHA256, caveats). 20 tests.
- `src/l402/gateway.ts` — Hono middleware: 402 challenges + L402 token verification.
- `src/l402/gateway-server.ts` — Standalone server with upstream proxy (env-configurable).

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

**lnget compatibility:** Protocol flow (402 + WWW-Authenticate header format) is compatible. Macaroon serialization is not — Golem uses JSON-based format, lnget expects libmacaroons v2 binary. Fixable but not a PoC priority.

### Credentials

Voltage LND macaroon is read from `VOLTAGE_MACAROON` env var (base64-encoded). Never hardcode in source files.

### Next Priorities
1. Safe harbor address registration (Step 8)
2. Railway template with /setup wizard
3. lnget compatibility (libmacaroons v2 binary serialization)
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
