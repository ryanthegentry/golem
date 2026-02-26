# Golem Architecture Overview

**Date:** 2026-02-26
**Milestone:** CLI complete — `golem init`, `golem balance`, `golem gateway`, `golem stats`. 93 tests passing, zero TypeScript errors. Live L402 payment validated end-to-end on mutinynet via Voltage LND → Boltz → Ark.

---

## Layer 0: Ark Protocol

Ark is an off-chain Bitcoin protocol. Instead of Lightning channels, it uses **VTXOs** (Virtual Transaction Outputs) — off-chain UTXOs that live inside a shared transaction tree managed by an **ASP** (Ark Service Provider).

Key properties:
- VTXOs are real Bitcoin, redeemable on-chain at any time
- They expire on ~4 week timelocks — if you don't refresh, you lose them
- The ASP runs **rounds** (~every minute on mutinynet) that batch operations
- No channels, no routing, no liquidity management for the user

Ark Labs runs the reference ASP at `mutinynet.arkade.sh`. That's who Tiero's team is.

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
     ┌─────────┴─────────┐
     │                   │
  MockSigner        TapsignerSigner (future)
  (in-memory key)   (NFC card, $20)
```

**MockSigner** holds a secp256k1 keypair in memory. Private key is in a `#secretKey` private field — never logged, never returned, never serialized.

**GolemIdentity** bridges `GolemSigner` → SDK's `Identity` interface. Instead of the SDK calling `tx.sign(privateKey)` directly, GolemIdentity:
1. Extracts PSBT bytes from the SDK's Transaction
2. Sends them to GolemSigner for signing
3. Reconstructs the signed Transaction from the result

The key never leaves the signer. The wallet never touches it. In production, MockSigner swaps out for a Tapsigner (NFC card) or phone keystore. Same interface, same boundary.

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

REVERSE SWAP (receive Lightning payment):
  Lightning payment → Boltz → new Ark VTXO
  "Someone pays a Lightning invoice, I get Ark sats"
```

Neither direction requires running an LND node. Boltz is the bridge.

## Layer 5: L402 Gateway

L402 is the HTTP 402 ("Payment Required") protocol. A server returns a 402 with a Lightning invoice + macaroon. The client pays the invoice, gets a preimage, and uses `macaroon:preimage` as an auth token.

Golem's L402 gateway is Hono middleware:

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

The macaroon is HMAC-SHA256 signed by a root key. It embeds the payment hash. When the client provides a preimage that SHA256-hashes to the embedded payment hash, it proves they paid. Zero database lookups. Stateless.

## Layer 6: Golem CLI

Commander.js wrapping everything above:

```
~/.golem/
  ├── config.json    (network, ark server, private key hex, wallet address)
  └── data/          (SDK's persistent wallet state via FileSystemStorageAdapter)
```

- `golem init` → generate key, connect to ASP, get address, save config
- `golem balance` → load config, create wallet from config, query balance
- `golem gateway` → load config, create wallet, create Lightning provider, start L402 middleware
- `golem stats` → HTTP GET to running gateway's `/stats` endpoint

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
| Ark ASP | Ark Service Provider | Ark Labs (Tiero) | `mutinynet.arkade.sh` |
| Golem Gateway | L402 reverse proxy | Us (the operator) | `localhost:8402` |
| Mock backend | Upstream API being monetized | Us (demo) | `localhost:3097` |
| Golem wallet | Ark client via SDK | Inside the gateway process | In-memory + `~/.golem/data/` |

### What Golem adds on top of the SDK

The SDK gives you a wallet. Golem adds:

1. **Signer isolation** — key never in wallet memory, swappable signer backends
2. **VTXO lifecycle management** — automated refresh before expiry (the core agent)
3. **OOR exposure limits** — caps how much you can send without settlement
4. **Lightning without LND** — Boltz swaps give you Lightning send/receive
5. **L402 gateway** — monetize any HTTP API with Lightning payments to Ark
6. **CLI** — one-command wallet + gateway setup with persistent config
7. **Web UI** — PWA for mobile wallet access (separate from the CLI)

The SDK is the engine. Golem is the car.
