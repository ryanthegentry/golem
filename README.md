# Golem

Self-custodial Bitcoin wallet on Ark with an L402 gateway for AI agents. Agents receive Lightning payments via Boltz reverse swaps that settle to Ark VTXOs — no LN node required. L402 gates are configurable for arbitrary endpoints, and are managed by the gateway process. Phase 1.5 covenant-based keyless receive is proven end-to-end on regtest (boarding → claim → refresh → consolidate), with production wiring gated on Boltz Path B. See [docs/COVENANT.md](docs/COVENANT.md).

**A note on AI assistance:** Most of this codebase was written with heavy AI assistance (Claude Code / Sonnet/Opus). The architecture, security model, test discipline, and edge-case handling are mine — the AI did the typing, I did the engineering. Every commit was reviewed; every change has tests. If you find a bug, it's mine, not the AI's.

## Quick Start

```bash
git clone https://github.com/ryanthegentry/golem.git
cd golem
npm install
cp .env.example .env        # Edit with your values (optional for testnet)
npm test                     # 690 tests, ~10s

# Create a wallet on mutinynet (default)
npm run golem -- init
npm run golem -- balance

# Start an L402 gateway proxying to your API
npm run golem -- gateway --upstream http://localhost:3000 --price 100 --port 8402
npm run golem -- stats       # Payment stats per rail

# Browse the L402 service directory
npm run golem -- directory list
npm run golem -- directory search "weather"
```

The gateway creates Lightning invoices via Boltz reverse swaps and receives Ark-native OOR payments directly. See `.env.example` for all options.

Mainnet: `GOLEM_NETWORK=mainnet npm run golem -- init --encrypt --safe-harbor <btc-address>`

## Current Status

- L402 gateway with dual-mode payment — Lightning (via Boltz) + Ark-native OOR
- CLI: `golem init`, `golem balance`, `golem gateway`, `golem stats`, `golem pay`, `golem receive`, `golem sweep`, `golem safe-harbor`, `golem exit`, `golem reserve`, `golem serve`, `golem directory`
- ServerSigner with AES-256-GCM encryption (scrypt key derivation)
- Safe harbor emergency exit (cooperative offboard + unilateral fallback)
- **690 passing tests** across 60 test files, live on mutinynet and mainnet
- Telegram monitoring bot with real-time L402 payment notifications
- `golem gateway init` — auto-discovery for Ollama and OpenAI upstreams, writes `golem.yaml`
- Auto-registration with [402index.io](https://402index.io) on gateway start
- Response caching with configurable TTL and price discount
- Live on mainnet (Railway deployment)
- Status: [`golem-production.up.railway.app`](https://golem-production.up.railway.app) responds from Railway
- Post-auth HTTP method validation (`GOLEM_UPSTREAM_METHOD` env var)
- Macaroon interop fixture for cross-language testing (JS ↔ Go)
- Performance: 402 challenge in 139ms, LN payment in ~1s, token verify in 9ms
- [402index.io](https://402index.io) live with 60K+ paid API endpoints indexed (L402 + x402 + MPP)

## Architecture

**Three-component model (non-negotiable boundary):**

```
┌──────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│       SIGNER         │     │        AGENT         │     │        STATE        │
│  (Mobile or HW key)  │     │    (User-Owned)      │     │   (Arkade / ASP)    │
│                      │     │                      │     │                     │
│ • Holds private keys │     │ • Monitors VTXOs     │     │ • VTXO ownership    │
│ • Signs transactions │◄────│ • Proposes txs       │────►│ • Round history     │
│ • Tiered by amount   │     │ • Consolidates VTXOs │     │ • Transaction trees │
│                      │     │ • User deploys it    │     │                     │
│ MOBILE: <0.21 BTC    │     │ • Claim daemon       │     │                     │
│ HARDWARE: ≥0.21 BTC  │     │   (covenant, no key) │     │                     │
└──────────────────────┘     └──────────────────────┘     └─────────────────────┘
```

Phase 1 ships ServerSigner (hot key encrypted on disk) — same security model as every LN node. The Mobile/Hardware tiers in the diagram are the Phase 2 target. Phase 1.5 covenant-based keyless receive (server holds zero key material) is proven end-to-end on regtest; mainnet wiring is gated on Boltz Path B. See [docs/COVENANT.md](docs/COVENANT.md).

**L402 Gateway — Lightning path** (backward-compatible with lnget/Aperture):

```
Client                    Gateway (port 8402)              Upstream API
  │                           │                                │
  │  GET /v1/aqi              │                                │
  │──────────────────────────>│                                │
  │                           │  No auth header?               │
  │                           │  createLightningInvoice(1000)  │
  │                           │  (Boltz reverse swap setup)    │
  │  402 + invoice + macaroon │                                │
  │<──────────────────────────│                                │
  │                           │                                │
  │  (pay invoice via LN)     │                                │
  │                           │                                │
  │  GET /v1/aqi              │                                │
  │  Authorization: L402      │                                │
  │    macaroon:preimage      │                                │
  │──────────────────────────>│                                │
  │                           │  verify(macaroon, preimage) ✓  │
  │                           │  proxy request ───────────────>│
  │                           │  upstream response <───────────│
  │  200 + AQI data           │                                │
  │<──────────────────────────│                                │
```

**L402 Gateway — Ark-native OOR path** (faster, no Lightning intermediary):

```
Client                    Gateway (port 8402)              Upstream API
  │                           │                                │
  │  GET /v1/aqi              │                                │
  │──────────────────────────>│                                │
  │  402 + invoice + macaroon │                                │
  │  + ark_payment { address, │                                │
  │    amount, payment_id,    │                                │
  │    macaroon }             │                                │
  │<──────────────────────────│                                │
  │                           │                                │
  │  OOR send (1069 sats)     │  VTXO listener detects         │
  │  to gateway Ark address   │  incoming VTXO by amount       │
  │──────────────────────────>│  match → fulfills payment      │
  │                           │                                │
  │  GET /l402/preimage       │                                │
  │    ?payment_id=X          │                                │
  │──────────────────────────>│                                │
  │  { preimage, macaroon }   │                                │
  │<──────────────────────────│                                │
  │                           │                                │
  │  GET /v1/aqi              │                                │
  │  Authorization: L402      │                                │
  │    macaroon:preimage      │                                │
  │──────────────────────────>│  verify(macaroon, preimage) ✓  │
  │                           │  proxy request ───────────────>│
  │  200 + AQI data           │                                │
  │<──────────────────────────│                                │
```

## Documentation

| Document | Description |
|---|---|
| [docs/COVENANT.md](docs/COVENANT.md) | Covenant architecture for keyless agent receive — three-leaf taptree with recursive covenants via Arkade introspection opcodes |
| [docs/research-priorities.md](docs/research-priorities.md) | Open research questions, known unknowns, and resolved items |
| [docs/signer-security.md](docs/signer-security.md) | Three-component model, signer interface, tiered security |
| [docs/architecture-overview.md](docs/architecture-overview.md) | Layered architecture, L402 gateway flows, full test walkthrough |
| [docs/ark-reference.md](docs/ark-reference.md) | Ark protocol specifics — VTXO lifecycle, rounds, fees, Boltz |
| [docs/sdk-identity-analysis.md](docs/sdk-identity-analysis.md) | Ark SDK Identity interface analysis |
| [docs/safe-harbor-design.md](docs/safe-harbor-design.md) | Safe harbor emergency exit design and edge cases |
| [docs/DESIGN.md](docs/DESIGN.md) | Visual design system and CLI output aesthetic |
| [docs/PROVIDER-GUIDE.md](docs/PROVIDER-GUIDE.md) | Step-by-step guide: monetize any API with L402 payments |
| [docs/l402-target-apis.md](docs/l402-target-apis.md) | Target API verticals for L402 gateway adoption |
| [docs/PHASE-1.5-LIMITS.md](docs/PHASE-1.5-LIMITS.md) | Phase 1.5 scope, current upstream gaps, and what wiring lands when Boltz Path B ships |
| [docs/RUST-SDK-COMPATIBILITY.md](docs/RUST-SDK-COMPATIBILITY.md) | TS↔Rust SDK call mapping for the planned Rust rewrite |

## Tests

60 test files covering:

- **Wallet**: creation, boarding, OOR sends, balance, VTXO expiry tracking
- **L402 gateway**: macaroon minting/verification, dual-mode 402 challenges, proxy routing, rate limiting
- **Security**: constant-time preimage verification, per-macaroon root keys, time-before caveats, IP rate limiting, with dedicated security test coverage
- **Safe harbor**: cooperative offboard, unilateral exit, emergency threshold monitoring
- **Signer**: MockSigner, ServerSigner, AES-256-GCM encryption, scrypt key derivation
- **Agent**: refresh scheduling, expiry calculation, consolidation logic, emergency exit
- **Network**: mainnet/mutinynet/regtest config, address validation, Boltz API integration
- **Monitoring**: Telegram alerts, formatter, bot commands
- **Directory**: 402index.io API client

```bash
npm test              # Run all 690 tests
npm run test:watch    # Watch mode
```

## Key Dependencies

- [`@arkade-os/sdk`](https://github.com/arkade-os/ts-sdk) — Ark protocol SDK (wallet, VTXOs, rounds)
- [`@arkade-os/boltz-swap`](https://github.com/arkade-os/boltz-swap) — Lightning swaps via Boltz
- [`hono`](https://hono.dev) — HTTP framework for gateway and API
- [`macaroon`](https://www.npmjs.com/package/macaroon) — Go macaroon library JS port (same as LND/Aperture)
- [`@scure/btc-signer`](https://github.com/paulmillr/scure-btc-signer) — Transaction construction
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — Macaroon store for anti-replay
- [`commander`](https://github.com/tj/commander.js) — CLI framework
- [`js-yaml`](https://github.com/nodeca/js-yaml) — YAML parsing for `golem.yaml` config

## License

ISC
