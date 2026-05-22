# Golem Rust Rewrite — System Overview

**Date:** 2026-03-17 | **Phase:** 0.5 (Formal Spec) | **Source:** golem TypeScript implementation (690 tests)

## Architecture

```
                    +-----------+
                    |   CLI     | (clap)
                    +-----+-----+
                          |
          +---------------+---------------+
          |               |               |
    +-----+-----+  +-----+-----+  +------+------+
    |  Gateway   |  |  Server   |  |  Telegram   |
    |  (axum)    |  |  (axum)   |  |  Bot        |
    +-----+------+  +-----+-----+  +------+------+
          |               |               |
    +-----+------+        |               |
    | L402       |        |               |
    | Macaroon   |        |               |
    | Cache      |        |               |
    +-----+------+        |               |
          |               |               |
    +-----+---------------+---------------+-----+
    |              GolemWallet                    |
    |  (send mutex, OOR limit, safe harbor)      |
    +-----+----+----+------+----+----+-----------+
          |    |    |      |    |    |
          v    v    v      v    v    v
    +----+ +--+ +--+  +---+ +--+ +-----+
    |SDK | |LN| |OOR| |Ref| |Sw| |Cov  |
    |Clt | |  | |Lst| |Agt| |ep| |enant|
    +----+ +--+ +--+  +---+ +--+ +-----+
```

## Dependency Graph (Module Edges)

```
CLI ──> Config ──> Wallet ──> SDK Client (ark-client)
                          ──> Lightning (SDK Boltz methods)
                          ──> OOR Listener (SDK gRPC stream: subscribe_to_scripts)
    ──> Gateway ──> L402/Macaroon (HMAC-SHA256 mint/verify)
               ──> L402/Proxy ──> Upstream HTTP
               ──> Lightning (invoice generation via SDK get_ln_invoice)
               ──> OOR Listener (Ark-native receive for dual-mode)
               ──> ResponseCache (SQLite, TTL, price discount)
    ──> RefreshAgent ──> Wallet (list_vtxos, settle)
                    ──> Emergency Exit (collaborative_redeem / unilateral_exit)
                    ──> BlockHeightFetcher (Esplora /blocks/tip/height)
    ──> Telegram Bot ──> Wallet (balance, VTXOs, tx history)
                    ──> Gateway (stats)
                    ──> RefreshAgent (status, last event)
    ──> AutoSweep ──> Wallet (getBalance)
                 ──> Lightning (sendLightningPayment)
                 ──> AddressResolver (LNURL-pay, Lightning Address)
    ──> Server ──> Wallet (receive, send, balance)
              ──> L402 (verify endpoint)
              ──> EventLog (SQLite append-only)
    ──> Registry ──> 402index API (POST /api/gateways)
    ──> Directory ──> 402index API (GET /api/directory)
    ──> Monitoring ──> Telegram (sendAlert)
```

## Data Flow: L402 Payment (Dual-Mode)

```
Client ──HTTP──> Gateway
                  │
                  ├── Check auth header → if valid L402 token, pass through
                  │
                  ├── No auth → issue 402 challenge:
                  │     ├── Mint macaroon (HMAC-SHA256 chain)
                  │     ├── Create Lightning invoice (SDK get_ln_invoice)
                  │     ├── Optionally include Ark OOR payment option
                  │     └── Return 402 + WWW-Authenticate + JSON body
                  │
                  └── Client pays → retries with L402 header:
                        ├── Lightning: preimage from Boltz claim
                        └── Ark OOR: preimage from /l402/preimage polling
```

## Data Flow: Emergency Exit

```
RefreshAgent tick()
  │
  ├── Check VTXO expiry (block-height or timestamp)
  ├── If within threshold (72h default) AND consecutiveFailures > 0:
  │     │
  │     ├── Try cooperative: collaborative_redeem(rng, safe_harbor, amount)
  │     │     └── Requires ASP online
  │     │
  │     └── Fallback unilateral: build_unilateral_exit_trees()
  │           ├── broadcast_next_unilateral_exit_node() [progressive]
  │           ├── Wait for confirmations
  │           ├── Repeat until all nodes confirmed
  │           ├── Wait for exit delay
  │           └── send_on_chain(safe_harbor, amount)
  │
  └── On success: stop polling, emit emergency_exit_completed
```

## Rust SDK Integration Points

| Golem Module | SDK Method(s) | Transport |
|---|---|---|
| Wallet.getBalance | `client.offchain_balance()` | gRPC |
| Wallet.getVtxos | `client.list_vtxos()` | gRPC |
| Wallet.send | `client.send_vtxo(addr, amt)` | gRPC |
| Wallet.settle | `client.settle(rng)` | gRPC |
| Wallet.offboard | `client.collaborative_redeem(rng, addr, amt)` | gRPC |
| Wallet.emergencyExit | `client.build_unilateral_exit_trees()` | gRPC |
| Lightning.createInvoice | `client.get_ln_invoice(amt, ext_id)` | gRPC+Boltz |
| Lightning.payInvoice | `client.pay_ln_invoice(invoice)` | gRPC+Boltz |
| Lightning.claim | `client.claim_vhtlc(id, preimage)` | gRPC+Boltz |
| OOR Listener | `client.subscribe_to_scripts(addrs)` | gRPC stream |
| Address | `client.get_offchain_address()` | gRPC |
| Boarding | `client.get_boarding_address()` | gRPC |

## Required Trait Implementations

| Trait | Implementation | Effort |
|---|---|---|
| `Blockchain` | Esplora HTTP wrapper (~200 LOC) | Moderate |
| `KeyProvider` | Use `StaticKeyProvider` (SDK-provided) | Zero |
| `OnchainWallet` | Use `ark-bdk-wallet` | Low |
| `BoardingWallet` | Use `ark-bdk-wallet` | Low |
| `SwapStorage` | Use `SqliteSwapStorage` (feature flag) | Zero |

## Cargo Workspace Structure (Proposed)

```
golem/
├── Cargo.toml (workspace)
├── golem-core/        # Config, types, storage, auth, utils
├── golem-wallet/      # GolemWallet wrapper, OOR limit, send mutex
├── golem-agent/       # RefreshAgent, expiry, emergency exit
├── golem-lightning/    # Boltz wrapper, swap monitoring
├── golem-l402/        # Macaroon, gateway, cache, proxy
├── golem-covenant/    # Arkade script, introspector, VTXO construction
├── golem-sweep/       # AutoSweep, address resolver
├── golem-telegram/    # Bot, formatter, commands
├── golem-server/      # HTTP server, event log
├── golem-cli/         # CLI entry point (clap)
├── golem-directory/   # 402index client, registration
└── golem-monitoring/  # Alerts
```

## Quality Gate: Test Coverage

**TS source:** 690 tests.
**Specs document:** Rust equivalence map from the earlier TypeScript suite.
**Known mapping gaps:** Accounted for by:
- Signer encryption tests (22): Out of scope for Phase 1 (`StaticKeyProvider` replaces encrypted key storage)
- Identity PSBT/MuSig2 tests (8): Absorbed by SDK internals (Golem doesn't manage signing sessions)
- CLI integration tests: Not individually specified (delegate to library functions tested in their respective specs)
- Approximate counts rounded conservatively (~50 means 50-60 in practice)

**All 20 TS source directories are covered.** Every public API has a Rust equivalent or SDK mapping. Integration points (gRPC, Boltz, Esplora, Telegram, 402index) are documented with transport and timeout details.
