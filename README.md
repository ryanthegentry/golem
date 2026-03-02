# Golem

Self-custodial Bitcoin wallet on Ark with an L402 gateway for AI agents. Agents receive Lightning payments via Boltz reverse swaps that settle to Ark VTXOs — no LND or CLN node required. Think "Aperture without LND." Path to covenant-enabled keyless receive once Arkade ships introspection opcodes (OP_SUCCESS202/207/209/213).

## Quick Start

```bash
git clone <repo-url>
cd golem
npm install
cp .env.example .env        # Edit with your values (optional for testnet)
npm test                     # 336 tests, ~2s

# Create a wallet on mutinynet (default)
npm run golem -- init
npm run golem -- balance

# Start an L402 gateway proxying to your API
npm run golem -- gateway --upstream http://localhost:3000 --price 100 --port 8402
npm run golem -- stats       # Payment stats per rail

# Browse the L402 service directory (mainnet endpoints only)
npm run golem -- directory list
npm run golem -- directory search "weather"
```

No LND node required. The gateway creates Lightning invoices via Boltz reverse swaps and receives Ark-native OOR payments directly. See `.env.example` for all options.

Mainnet: `GOLEM_NETWORK=mainnet npm run golem -- init --encrypt --safe-harbor <btc-address>`

## Current Status

- L402 gateway with dual-mode payment — Lightning (via Boltz) + Ark-native OOR
- CLI: `golem init`, `golem balance`, `golem gateway`, `golem stats`, `golem pay`, `golem directory search`
- ServerSigner with AES-256-GCM encryption (scrypt key derivation)
- Safe harbor emergency exit (cooperative offboard + unilateral fallback)
- **336 passing tests** across 26 test files, live on mutinynet and mainnet
- Telegram monitoring bot with real-time L402 payment notifications
- First third-party transaction: 21,000 sats sent to Ark Labs maintainer via agent-managed wallet
- Performance: 402 challenge in 139ms, LN payment in ~1s, token verify in 9ms
- [402index.io](https://402index.io) live with 13K+ L402 endpoints indexed

## Architecture

**Three-component model (non-negotiable boundary):**

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│       SIGNER        │     │        AGENT         │     │        STATE        │
│  (Mobile or HW key) │     │    (User-Owned)      │     │   (Arkade / ASP)    │
│                     │     │                     │     │                     │
│ • Holds private keys │     │ • Monitors VTXOs     │     │ • VTXO ownership    │
│ • Signs transactions │◄────│ • Proposes txs       │────►│ • Round history     │
│ • Tiered by amount   │     │ • Consolidates VTXOs │     │ • Transaction trees │
│                     │     │ • User deploys it    │     │                     │
│ MOBILE: <0.21 BTC   │     │ • Claim daemon       │     │                     │
│ HARDWARE: ≥0.21 BTC │     │   (covenant, no key) │     │                     │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
```

Phase 1 uses ServerSigner (hot key encrypted on disk) — same security model as every LN node. Phase 1.5 targets covenant-based keyless receive where the server never holds a signing key. See [docs/COVENANT.md](docs/COVENANT.md).

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
| [docs/COVENANT.md](docs/COVENANT.md) | Covenant architecture for keyless agent receive — four-leaf taptree with recursive covenants via Arkade introspection opcodes |
| [docs/vision.md](docs/vision.md) | Product vision and phased roadmap |
| [docs/STORYBOARD.md](docs/STORYBOARD.md) | User stories — provider onboarding to agent-to-agent commerce |
| [docs/research-priorities.md](docs/research-priorities.md) | Open research questions, known unknowns, and resolved items |
| [docs/signer-security.md](docs/signer-security.md) | Three-component model, signer interface, tiered security |
| [docs/ark-reference.md](docs/ark-reference.md) | Ark protocol specifics — VTXO lifecycle, rounds, fees, Boltz |
| [docs/sdk-identity-analysis.md](docs/sdk-identity-analysis.md) | Ark SDK Identity interface analysis |

## Tests

26 test files covering:

- **Wallet**: creation, boarding, OOR sends, balance, VTXO expiry tracking
- **L402 gateway**: macaroon minting/verification, dual-mode 402 challenges, proxy routing, rate limiting
- **Security**: constant-time preimage verification, per-macaroon root keys, time-before caveats, IP rate limiting (44 security tests)
- **Safe harbor**: cooperative offboard, unilateral exit, emergency threshold monitoring
- **Signer**: MockSigner, ServerSigner, AES-256-GCM encryption, scrypt key derivation
- **Agent**: refresh scheduling, expiry calculation, consolidation logic, emergency exit
- **Network**: mainnet/mutinynet/regtest config, address validation, Boltz API integration
- **Monitoring**: Telegram alerts, formatter, bot commands
- **Directory**: 402index.io API client

```bash
npm test              # Run all 336 tests
npm run test:watch    # Watch mode
```

## Key Dependencies

- [`@arkade-os/sdk`](https://github.com/ArkadeLabs/ts-sdk) — Ark protocol SDK (wallet, VTXOs, rounds)
- [`@arkade-os/boltz-swap`](https://github.com/ArkadeLabs/boltz-swap) — Lightning swaps via Boltz
- [`hono`](https://hono.dev) — HTTP framework for gateway and API
- [`macaroon`](https://www.npmjs.com/package/macaroon) — Go macaroon library JS port (same as LND/Aperture)
- [`@scure/btc-signer`](https://github.com/nicolo-ribaudo/btc-signer) — Transaction construction
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — Macaroon store for anti-replay
- [`commander`](https://github.com/tj/commander.js) — CLI framework

## License

ISC
