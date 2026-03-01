# Golem — Vision

## The Long-Term Goal

Golem's long-term vision is to provide self-custodial Bitcoin users with neobank-level financial services: spend, earn, save, lend, and trade — in both BTC and USD stablecoins — without surrendering custody of their assets.

This vision serves a global market of dual-currency citizens who want a self-sovereign but user-friendly financial stack. These users have been underserved by existing self-custodial Bitcoin and Lightning wallets, which do not support stablecoins, yield, or trading, and historically had poor UX.

## Why This Matters

Today's options force a tradeoff:
- **Custodial neobanks** (Cash App, Strike, Revolut): Good UX, full custody risk, censorship vulnerable
- **Self-custodial wallets** (Phoenix, Breez, BlueWallet): Self-sovereign, but BTC-only, no yield, no stablecoins, manual management
- **DeFi wallets** (EVM-based): Yield and stablecoins, but not Bitcoin-native, smart contract risk, poor mobile UX
- **Custodial agent wallets** (Claw Cash): Convenience + agent automation, but custodial. Trust Evervault Enclave.
- **L402/agent payment tools** (lnget, Aperture): Machine-to-machine payments exist, but require running an LND node. No self-custodial option on Ark.

Golem eliminates this tradeoff by combining self-custody with autonomous management — an agent handles the complexity while the user retains full control. The L402 gateway makes Golem the easiest path for API providers and AI agents to accept and make Bitcoin payments without custodial infrastructure.

## The Path

### Today (Phase 1): Agent-Managed Ark Wallet
- Automated VTXO refresh
- Tiered security (mobile → hardware)
- Lightning onboarding via Boltz (500-sat minimum)
- Dual-mode L402 gateway (Lightning + Ark-native OOR)
- CLI: `golem init`, `golem balance`, `golem gateway`, `golem stats`, `golem pay`
- PWA web UI for mobile wallet access
- 117 tests passing on mutinynet
- User-owned agent infrastructure
- Hot key ServerSigner (same security model as every LN node and Claw Cash)

### Phase 1 continued (pre-mainnet):
- Safe harbor address registration
- Golem Service Directory (L402 API registry for agent discoverability)
- ServerSigner encryption (AES-256)
- Railway template with /setup wizard
- lnget compatibility end-to-end test

### March-April 2026 (Phase 1.5): Covenant Claim Daemon
- Keyless Lightning receive via Arkade introspection opcodes
- Server NEVER holds a signing key after init
- Claim daemon detects VHTLCs, constructs covenant-valid claims using just the preimage
- ~2-3 days of CC work once opcodes are live
- Critical unlock: strongest security model for API providers

### April-May 2026 (Phase 2): DeFi Agent
- Stablecoin support (BTC + USD)
- Lending and yield (Fuji-style contracts)
- Auto-rebalancing between BTC and stablecoins
- Tapsigner hardware flow
- 2-of-2 multisig if additional security needed
- Mobile app as primary surface

### Mid-2026+ (Phase 3): Full Financial Stack
- Decentralized service directory (Nostr-based federation of L402 registries)
- Cross-chain stablecoin rails
- DCA automation
- Multi-ASP failover for resilience
- Lightning routing optimization
- Tax reporting
- Bill pay and debit card integration (partner-dependent)

## The Neobank Framing

The word "neobank" is aspirational and describes where Golem is headed — not what the PoC is. The PoC is an agent-managed self-custodial Ark wallet with an L402 payment gateway.

We deliberately do not use "neobank" in product marketing or the PoC because:
1. It creates expectations (FDIC insurance, bill pay, debit cards) the product can't meet yet
2. It attracts regulatory attention that a self-custodial wallet shouldn't invite
3. The immediate value proposition is simpler: "Your bitcoin is protected, automatically" + "Monetize any API with one command"

The neobank framing belongs in investor conversations and long-term strategy, not in the product itself.

## Competitive Landscape

- **Claw Cash** (https://clw.cash/): Tiero's custodial agent wallet on Ark. Same Boltz SwapManager pattern. No L402, no multisig, no covenants. Complementary — Claw Cash = custodial convenience, Golem = self-custodial with L402. Tiero actively helping design Golem.
- **Phoenix / Breez / BlueWallet:** Self-custodial Lightning. No Ark, no agent, no L402 gateway. Manual management.
- **lnget / Aperture:** L402 tools that require an LND node. Golem provides L402 without LND.
- **MoneyDevKit:** Different market (serverless Lightning checkout for merchants, built on LDK). Not a competitor.

## Team (Potential)

The PoC is being built solo by Ryan using Claude Code. If the PoC validates and there are no obvious barriers to building a billion-dollar company:

- **Ben Carman** (ex-Mutiny Wallet founder): Deep self-custodial Bitcoin/LN wallet experience
- **Justin Moon** (ex-Fedi founder): Federated custody and Bitcoin wallet UX experience

Both are friends, currently building a Nostr messaging app with Signal encryption for agents. Interested in adding Bitcoin payments. A natural path would be integrating Golem's payment capabilities into their agent communication layer.

## Market Size

The target market spans two dimensions:

**Self-custodial financial management:** Every Bitcoin holder who wants to use their BTC for more than just holding — but refuses to give up custody. As Bitcoin adoption grows and self-custodial infrastructure matures, this market expands. Conservative framing: If 5% of Bitcoin holders (estimated 200-400M globally) would pay $10-50/month for autonomous self-custodial financial management, the addressable market is $1.2-24B annually.

**Agent economy:** AI agents that need to make and receive payments. Lightning Labs (L402), Coinbase (AgentKit), and others are creating this market. Golem is the easiest on-ramp: self-custodial, no LND node, dual-mode (Lightning + Ark), one-command setup. As the agent economy grows, every API provider and every AI agent needs a payment rail. Golem provides it without custodial infrastructure.

## Why Now

1. Ark protocol reaching feature completeness (delegation live, assets in weeks, DeFi in months)
2. Ark Labs explicitly wants third parties to build neobanks on Arkade
3. Personal agent infrastructure (Railway, OpenClaw) makes user-owned agents practical
4. Hardware signer costs dropping (Tapsigner at $20 makes tiered security accessible)
5. No one has built this yet — the agent-managed Ark wallet is an empty niche
6. Agent economy is forming — Lightning Labs, Coinbase, and others creating the market for machine-to-machine payments. Golem = easiest self-custodial on-ramp for AI agents
7. Covenant-based keyless receive = genuine first. No equivalent in Lightning or existing Ark implementations. Receive payments without a signing key on the server.
8. No canonical registry of L402-enabled APIs exists. The agent economy needs a discovery layer — agents need to find APIs, APIs need to find agents. Golem can own this by shipping early.
