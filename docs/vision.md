# Golem — Vision

*Updated March 1, 2026*

## What Golem Is

Golem is autonomous Bitcoin payment infrastructure built on the Ark protocol. It enables AI agents to receive Lightning payments, refresh VTXOs, and consolidate funds — without ever holding the user's private key.

The core technical breakthrough is a recursive covenant architecture using Arkade's introspection opcodes that eliminates key delegation entirely. A server can receive Lightning payments with zero key material on the server. The user's spending key lives only on their mobile phone or hardware wallet.

For developers: monetize any API in one command, get paid in bitcoin, no Lightning node required.
For agents: autonomous payment rails with self-custodial security guarantees.
For users: a guardian that manages your Bitcoin while you retain full control.

## Why This Matters

Today's options force a tradeoff:

- **Custodial neobanks** (Cash App, Strike, Revolut): Good UX, full custody risk, censorship vulnerable
- **Self-custodial wallets** (Phoenix, Breez, BlueWallet): Self-sovereign, but BTC-only, manual management, require running infrastructure
- **Agent payment rails** (x402): Real traction (12K+ endpoints, ~500K payments/week), but stablecoin-first on EVM. Not Bitcoin-native, not self-custodial.
- **L402 gateways** (Aperture, Lightning Labs agent-tools): Bitcoin-native, but require running an LND node. The node is the complexity.
- **Custodial agent wallets** (other agent wallet): Agent-focused, Ark-based, but keys held in operator's enclave. Good for convenience, not for sovereignty.

Golem eliminates this tradeoff: "Aperture without LND." Same L402 standard, no node required. Self-custodial by default. And with covenant-enabled keyless receive, the server never touches key material at all.

## The Path

### Phase 0 (Live): 402index.io — Distribution & Ecosystem Building
- ✅ Live at 402index.io
- ✅ 13,196 endpoints, 510 services, 400 providers
- ✅ Protocol split: 24 L402 / 376 x402 (quantifies the opportunity)
- ✅ Public REST API
- ✅ MCP server for agent discoverability
- 🔲 "The Bitcoin Case for Agent Payments" manifesto
- 🔲 Community building, content pipeline

### Phase 1 (Current): Alpha — Hot Key Mode
- ✅ 185 passing tests, live on mutinynet
- ✅ Mainnet deployment with network switching, encrypted config, monitoring
- ✅ ServerSigner with AES-256-GCM encryption (scrypt KDF, N=2^17)
- ✅ L402 gateway with dual-mode payment (Lightning + Ark-native OOR)
- ✅ CLI: `golem init`, `golem balance`, `golem gateway`, `golem stats`
- ✅ Safe harbor address for emergency on-chain ejection
- ✅ Telegram monitoring and alerts
- ✅ First third-party transaction: 21,000 sats sent to Ark Labs maintainer
- ✅ Timing: 402 challenge in 139ms, LN payment in ~1s, token verify in 9ms
- ✅ lnget compatibility tested and working
- 🔲 HTTPS for PWA functionality
- 🔲 3+ external developers testing on mainnet

### Phase 2: Covenant Mode — Keyless Agent Receive
**Gate:** Arkade introspection opcodes live on testnet (Ark Labs maintainer: "before this quarter ends" = March 2026)

The core technical moat. Recursive covenant architecture replaces hot key entirely:

- **Leaf 1 — Recursive Covenant:** `OP_INSPECTINPUTSCRIPTPUBKEY` + `OP_INSPECTOUTPUTSCRIPTPUBKEY` enforce "output must have same script as input." No signature required. Covers refresh AND consolidation. The covenant IS the authorization.
- **Leaf 2 — Alice's Spending Key:** Standard CHECKSIG for spending/withdrawal. Only operation requiring the master key. Key lives on mobile or hardware wallet.
- **Leaf 3 — Collaborative Path:** Alice + Operator cosign for Arkade transactions.
- **Leaf 4 — Unilateral Exit:** Alice + CSV timelock for force-exit if operator disappears.

What this eliminates: signing key on server (ever), delegation credentials, per-cycle mobile provisioning, key deletion concerns, sweep-based tier transitions.

L402 gateway gains authorize-and-capture: consumer authorizes payment via covenant, API delivers service, merchant captures after confirming delivery.

**Open questions:** round/forfeit + covenant VTXO compatibility (Ark Labs maintainer call scheduled), Boltz gateway support for covenant VHTLCs, OP_SUCCESS semantic edge cases.

### Phase 3: Agent Infrastructure Platform
- Publish recursive covenant VTXO template as open Arkade ecosystem standard
- SDKs for wallet developers to integrate agent-managed receive-only mode
- Reference mobile app
- Golem as middleware: the autonomous agent layer between AI agents and any Ark wallet
- Stablecoin support via Arkade assets (Fuji BTC-backed stablecoin shipping in weeks, USDT0 and potentially USDC/USDG via Taproot Assets by EOY 2026)

### Phase 4: Autonomous Financial Agent Layer
- Agent autonomously rebalances BTC/stablecoin positions
- Rolls lending positions, optimizes yield
- Manages structured products with programmable terms
- Management fees on AUM (25-50 bps annually) + performance fees

**Critical dependency:** Requires Arkade ecosystem maturation (stablecoins, lending, AMMs). With Fuji and USDT0 on the near-term horizon, this phase may arrive sooner than originally assumed.

## Team

Founding team. Open roles marked as such.

- **CEO / Product:** Ryan Gentry — Bitcoin protocol expertise (Lightning Labs), Ark architecture, built 402index.io and Golem prototype
- **CTO / Protocol:** Open — requires deep covenants expertise, Ark/Taproot internals
- **Engineering Lead / SDK & Infrastructure:** Open — requires wallet SDK experience, self-custodial UX
- **Design Lead:** Open — product design for Bitcoin fintech

## Ark Ecosystem Context

- **Ark Labs:** Public beta since October 2025. Raising $7M from Tether and others (announcement imminent). Partners: Breez, BlueWallet, BTCPayServer, BullBitcoin, Boltz.
- **Stablecoins:** Fuji (BTC-backed stablecoin) shipping in weeks. Close with USDT0 team. Taproot Assets supported for major stablecoin issuance (USDC, USDG). Major stablecoin on Ark by EOY 2026 is plausible.
- **Introspection opcodes:** The Arkade VM already evaluates these internally. Production availability for user-constructed scripts: "before this quarter ends" (Ark Labs maintainer, March 1, 2026).
- **Mainnet ASP:** `arkade.computer` running v0.8.11. 7-day VTXO expiry (not 30 days). 1-minute round sessions. 1 sat VTXO minimum. Boltz gateway minimums: 333 sats (enables micropayments).

## Market

**Agent economy:** x402 has grown from 0 to 12K+ endpoints in <12 months, with ~500K payments/week, backed by Coinbase/Cloudflare/Google. This validates that agent payment demand is real and growing exponentially. But it's stablecoin-first on EVM. The Bitcoin-native segment (24 L402 providers out of 376 total on 402index) represents both the current gap and the opportunity.

**Stablecoin catalyst:** With Arkade stablecoins arriving, Golem can compete in the broader agent payment market — not just Bitcoin micropayments, but stablecoin agent transactions with Bitcoin's self-custodial properties. This could expand the addressable market by 10-50x.

**Competitive landscape:** No one else is building a covenant-based keyless self-custodial agent wallet on Ark. Lightning Labs is building agent tools for LND (requires node management). x402 is stablecoin-first on EVM. other agent wallet is custodial. Golem occupies a unique position.

## Why Now

1. Arkade introspection opcodes shipping imminently — enables the core covenant architecture
2. Ark Labs well-funded (Tether backing) and actively shipping (stablecoins in weeks)
3. Strong candidate co-founders available and already building in adjacent space
4. Agent economy growing exponentially (x402 from 0 to 12K endpoints in <1 year)
5. 402index.io live as distribution channel (13K+ endpoints)
6. Working prototype with 336 tests and live transactions
7. No one else has built this yet — genuine first-mover advantage
