# Golem — Vision

## The Long-Term Goal

Golem's long-term vision is to provide self-custodial Bitcoin users with neobank-level financial services: spend, earn, save, lend, and trade — in both BTC and USD stablecoins — without surrendering custody of their assets.

This vision serves a global market of dual-currency citizens who want a self-sovereign but user-friendly financial stack. These users have been underserved by existing self-custodial Bitcoin and Lightning wallets, which do not support stablecoins, yield, or trading, and historically had poor UX.

## Why This Matters

Today's options force a tradeoff:
- **Custodial neobanks** (Cash App, Strike, Revolut): Good UX, full custody risk, censorship vulnerable
- **Self-custodial wallets** (Phoenix, Breez, BlueWallet): Self-sovereign, but BTC-only, no yield, no stablecoins, manual management
- **DeFi wallets** (EVM-based): Yield and stablecoins, but not Bitcoin-native, smart contract risk, poor mobile UX

Golem eliminates this tradeoff by combining self-custody with autonomous management — an agent handles the complexity while the user retains full control.

## The Path

### Today (Phase 1): Agent-Managed Ark Wallet
- Automated VTXO refresh
- Tiered security (mobile → hardware)
- Lightning onboarding via Boltz
- User-owned agent infrastructure

### April-May 2026 (Phase 2): DeFi Agent
- Stablecoin support (BTC + USD)
- Lending and yield (Fuji-style contracts)
- Auto-rebalancing between BTC and stablecoins

### Mid-2026+ (Phase 3): Full Financial Stack
- Cross-chain stablecoin rails
- DCA automation
- Multi-ASP failover for resilience
- Lightning routing optimization
- Tax reporting
- Bill pay and debit card integration (partner-dependent)

## The Neobank Framing

The word "neobank" is aspirational and describes where Golem is headed — not what the PoC is. The PoC is an agent-managed self-custodial Ark wallet.

We deliberately do not use "neobank" in product marketing or the PoC because:
1. It creates expectations (FDIC insurance, bill pay, debit cards) the product can't meet yet
2. It attracts regulatory attention that a self-custodial wallet shouldn't invite
3. The immediate value proposition is simpler: "Your bitcoin is protected, automatically"

The neobank framing belongs in investor conversations and long-term strategy, not in the product itself.

## Team (Potential)

The PoC is being built solo by Ryan using Claude Code. If the PoC validates and there are no obvious barriers to building a billion-dollar company:

- **Ben Carman** (ex-Mutiny Wallet founder): Deep self-custodial Bitcoin/LN wallet experience
- **Justin Moon** (ex-Fedi founder): Federated custody and Bitcoin wallet UX experience

Both are friends, currently building a Nostr messaging app with Signal encryption for agents. Interested in adding Bitcoin payments. A natural path would be integrating Golem's payment capabilities into their agent communication layer.

## Market Size

The target market is every Bitcoin holder who wants to use their BTC for more than just holding — but refuses to give up custody. As Bitcoin adoption grows and self-custodial infrastructure matures, this market expands.

Conservative framing: If 5% of Bitcoin holders (estimated 200-400M globally) would pay $10-50/month for autonomous self-custodial financial management, the addressable market is $1.2-24B annually.

## Why Now

1. Ark protocol reaching feature completeness (delegation live, assets in weeks, DeFi in months)
2. Ark Labs explicitly wants third parties to build neobanks on Arkade
3. Personal agent infrastructure (Railway, OpenClaw) makes user-owned agents practical
4. Hardware signer costs dropping (Tapsigner at $20 makes tiered security accessible)
5. No one has built this yet — the agent-managed Ark wallet is an empty niche
