# Golem Architecture Overview

**Date:** 2026-02-26
**Milestone:** CLI + dual-mode L402 gateway complete. 336 tests passing, zero TypeScript errors. Commands: `golem init`, `golem balance`, `golem gateway`, `golem stats`, `golem pay`. L402 gateway with V2 binary macaroons (`macaroon` npm package), per-macaroon root keys, time-before caveats, constant-time preimage verification, IP rate limiting. Dual-mode payment: Lightning (via Boltz) + Ark-native OOR. lnget wire compatibility validated. Live Lightning and Ark OOR payments validated end-to-end on mutinynet. Covenant-based keyless receive (Phase 1.5) designed, gated on Arkade introspection opcodes (March 2026).

---

## Layer 0: Ark Protocol

Ark is an off-chain Bitcoin protocol. Instead of Lightning channels, it uses **VTXOs** (Virtual Transaction Outputs) — off-chain UTXOs that live inside a shared transaction tree managed by an **ASP** (Ark Service Provider).

Key properties:
- VTXOs are real Bitcoin, redeemable on-chain at any time
- They expire on ~4 week timelocks — if you don't refresh, you lose them
- The ASP runs **rounds** (~every minute on mutinynet) that batch operations
- No channels, no routing, no liquidity management for the user

Ark Labs runs the reference ASP at `mutinynet.arkade.sh`.

## Layer 1: `@arkade-os/sdk` — Ark Labs' TypeScript SDK

This is Ark Labs' client library. It gives you:
- `Wallet` — connect to an ASP, get addresses, check balances, settle transactions
- `VtxoManager` — track VTXO expiry, renew them
- `Identity` — abstract interface the SDK uses for signing
- `FileSystemStorageAdapter` — persist wallet state to disk

The SDK expects you to give it an `Identity` that can sign transactions. Their built-in `SingleKey` identity holds a raw private key in memory and calls `tx.sign(privateKey)` directly.

## Layer 2: Golem's Signer Boundary

This is the architectural decision that makes Golem different from a normal SDK app.

```
┌─────────────────────────────────────────────────┐
│  GolemSigner interface                          │
│                                                 │
│  getPublicKey()                                 │
│  signTransaction(psbt) → signedPsbt             │
│  signMessage(msg, type) → signature             │
│  ping() → status                                │
└──────────────┬──────────────────────────────────┘
               │
     ┌─────────┼─────────────┐
     │         │             │
  MockSigner  AgentSigner  TapsignerSigner (future)
  (testing)   (hot key +   (NFC card, $20)
              spending caps)
```

**MockSigner** holds a secp256k1 keypair in memory. Private key is in a `#secretKey` private field — never logged, never returned, never serialized.

**GolemIdentity** bridges `GolemSigner` → SDK's `Identity` interface. Instead of the SDK calling `tx.sign(privateKey)` directly, GolemIdentity:
1. Extracts PSBT bytes from the SDK's Transaction
2. Sends them to GolemSigner for signing
3. Reconstructs the signed Transaction from the result

The key never leaves the signer. The wallet never touches it. In production, MockSigner swaps out for a Tapsigner (NFC card) or phone keystore. Same interface, same boundary.

**Phase 1.5 note:** Covenant-based receive eliminates the need for signing on the receive path entirely. The claim daemon constructs covenant-valid transactions using just the preimage — no `GolemSigner` call needed. Signing is only required for spending (send, refresh, consolidation).

## Layer 3: GolemWallet

Wraps the SDK Wallet with GolemSigner awareness:

```
GolemWallet
  ├── GolemSigner (signs things)
  ├── GolemIdentity (bridges signer → SDK)
  ├── SDK Wallet (talks to ASP)
  ├── VtxoManager (tracks expiry)
  └── OOR limit enforcement (caps per-send exposure)
```

`GolemWallet.create(signer, config)` wires everything together. Every other part of the system (CLI, API server, refresh agent) calls this one factory.

## Layer 4: Lightning via Boltz Swaps

Ark has no native Lightning. Golem gets Lightning through **Boltz**, a non-custodial swap provider. The `@arkade-os/boltz-swap` package provides:

- **`BoltzSwapProvider`** — talks to Boltz's REST API
- **`ArkadeLightning`** — wraps the swap provider with a high-level API: `createLightningInvoice()`, `sendLightningPayment()`
- **`SwapManager`** — background process that monitors pending swaps

Two swap directions:

```
SUBMARINE SWAP (send Lightning payment):
  Ark VTXO → Boltz → Lightning invoice paid
  "I have Ark sats, I want to pay a Lightning invoice"
  Fee: 0.01%

REVERSE SWAP (receive Lightning payment):
  Lightning payment → Boltz → new Ark VTXO
  "Someone pays a Lightning invoice, I get Ark sats"
  Fee: 0.4%
```

Neither direction requires running an LND node. Boltz is the bridge. Arkade-Boltz gateway minimum: **500 sats** (not standard Boltz's 50,000). This makes per-request L402 payments economically viable (~3 sats ≈ $0.002/request).

## Layer 5: L402 Gateway (Dual-Mode)

L402 is the HTTP 402 ("Payment Required") protocol. A server returns a 402 with a Lightning invoice + macaroon. The client pays the invoice, gets a preimage, and uses `macaroon:preimage` as an auth token.

Golem's L402 gateway is Hono middleware with **two payment rails**:

### Lightning Path (backward-compatible with lnget/Aperture)

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

### Ark-Native OOR Path (faster, no Lightning intermediary)

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

The Ark OOR path is ~1.2s vs ~5-20s for Lightning. The amount has a random 1-99 sat suffix (e.g., 1069 instead of 1000) to disambiguate concurrent payments. The gateway generates its own preimage, detects the incoming VTXO, and reveals the preimage at `/l402/preimage`. The consumer then uses the standard `Authorization: L402` header — existing `verifyL402Token()` is completely untouched.

The macaroon is a V2 binary token (same format as LND/Aperture, via the `macaroon` npm package — official JS port of Go's `go-macaroon/macaroon`). Each macaroon gets its own root key (per-macaroon root keys via `RootKeyStore`). It embeds the payment hash in a 38-byte identifier (version + payment_hash + root_key_id). When the client provides a preimage that SHA256-hashes to the embedded payment hash, it proves they paid. Verification uses `crypto.timingSafeEqual` for constant-time comparison. Time-before caveats prevent replay after TTL expires. Zero database lookups. Stateless (root keys stored in `~/.golem/root-keys.json` with 0600 permissions, separate from config).

**Known limitation:** Between HTLC settlement (preimage revealed) and the Boltz swap completing into the Ark wallet, there's a brief window where the gateway has verified the preimage but the sats haven't arrived as a VTXO. This is a Boltz swap latency issue, not an L402 vulnerability — the preimage proof-of-payment is valid immediately. Same trust model as OOR payments.

## Layer 6: Golem CLI

Commander.js wrapping everything above:

```
~/.golem/
  ├── config.json    (network, ark server, private key hex, wallet address)
  └── data/          (SDK's persistent wallet state via FileSystemStorageAdapter)
```

- `golem init` → generate key, connect to ASP, get address, save config
- `golem balance` → load config, create wallet from config, query balance
- `golem gateway` → load config, create wallet, create Lightning provider, start dual-mode L402 middleware
- `golem stats` → HTTP GET to running gateway's `/stats` endpoint (per-rail breakdown)
- `golem pay <url>` → L402 client: auto-pays 402 challenges from Ark wallet via Boltz submarine swap or Ark OOR (`--ark`)

## Layer 7: Golem Service Directory

A public registry of L402-enabled API endpoints. When `golem gateway` starts, it auto-registers in the directory. When an agent runs `golem directory search`, it queries the registry. When an `--agent-mode` wallet encounters a 402 from a known directory service, it auto-pays.

Phase 1: centralized REST API operated by Golem. Phase 3: decentralized via Nostr.

This is what turns Golem from a wallet+gateway into a platform. The directory creates the marketplace where APIs and agents find each other.

## The Full Test Flow

Here's exactly what happens when you run the live test from Voltage LND:

### Prerequisites (liquidity priming)

Lightning needs liquidity in both directions. On mutinynet testnet, this isn't automatic:

```
Step 0a: KEYSEND (create inbound liquidity for LND)
  Voltage LND ──25,000 sats──> Faucet node
  Result: LND's channel now has remote balance (inbound capacity)

Step 0b: SUBMARINE SWAP (give Boltz ARK liquidity)
  Ark wallet ──5,000 sats──> Boltz ──> LND invoice
  Result: Boltz now holds ARK-side funds for future reverse swaps
```

### The L402 payment

```
                    Voltage LND          Boltz             Golem Gateway
                    (mutinynet)       (swap provider)     (Ark wallet + L402)
                        │                  │                     │
1. Client hits /v1/aqi  │                  │                     │
   ─────────────────────┼──────────────────┼────────────────────>│
                        │                  │                     │
2. Gateway calls        │                  │   createInvoice()   │
   ArkadeLightning      │                  │<────────────────────│
                        │                  │                     │
3. Boltz creates a      │                  │                     │
   reverse swap:        │                  │                     │
   "pay this LN invoice,│                  │                     │
   I'll send ARK sats"  │                  │                     │
                        │                  │  invoice + macaroon │
4. Client gets 402      │                  │────────────────────>│
   <────────────────────┼──────────────────┼─────────────────────│
                        │                  │                     │
5. Client pays invoice  │   LN payment     │                     │
   via Voltage LND      │─────────────────>│                     │
                        │                  │                     │
6. Boltz receives LN,   │   preimage       │  Ark VTXO created  │
   settles reverse swap │<─────────────────│────────────────────>│
                        │                  │                     │
7. Client sends         │                  │  Authorization:     │
   macaroon:preimage    │                  │  L402 mac:preimage  │
   ─────────────────────┼──────────────────┼────────────────────>│
                        │                  │                     │
8. Gateway verifies:    │                  │                     │
   SHA256(preimage)     │                  │                     │
   == paymentHash       │                  │                     │
   in macaroon? ✓       │                  │                     │
                        │                  │  proxy to upstream  │
9. 200 + AQI data       │                  │                     │
   <────────────────────┼──────────────────┼─────────────────────│
```

The money moves: **LND → Boltz (Lightning) → Boltz (settles on Ark) → Golem's wallet (new VTXO)**

The proof moves: **Preimage travels back from Boltz → LND → Client → Gateway for verification**

### What each component actually is

| Component | What it is | Who runs it | Where |
|-----------|-----------|-------------|-------|
| Voltage LND | Lightning node | Us (test payer) | `golem-tester.u.voltageapp.io` |
| Boltz | Non-custodial swap provider | Boltz team | `api.boltz.mutinynet.arkade.sh` |
| Ark ASP | Ark Service Provider | Ark Labs | `mutinynet.arkade.sh` |
| Golem Gateway | L402 reverse proxy | Us (the operator) | `localhost:8402` |
| Mock backend | Upstream API being monetized | Us (demo) | `localhost:3097` |
| Golem wallet | Ark client via SDK | Inside the gateway process | In-memory + `~/.golem/data/` |

### What Golem adds on top of the SDK

The SDK gives you a wallet. Golem adds:

1. **Signer isolation** — key never in wallet memory, swappable signer backends
2. **VTXO lifecycle management** — automated refresh before expiry (the core agent)
3. **OOR exposure limits** — caps how much you can send without settlement
4. **Lightning without LND** — Boltz swaps give you Lightning send/receive
5. **L402 gateway** — monetize any HTTP API with dual-mode payments (Lightning + Ark OOR)
6. **CLI** — one-command wallet + gateway setup with persistent config
7. **Web UI** — PWA for mobile wallet access (separate from the CLI)
8. **Covenant-based keyless receive (Phase 1.5)** — genuinely new capability: receive Lightning payments without a signing key on the server. No equivalent in Lightning or Ark today.
9. **Service Directory** — public registry of L402 APIs, auto-registration from gateway, auto-discovery for agents

The SDK is the engine. Golem is the car.
