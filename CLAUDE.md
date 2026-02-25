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

### Task Priority
1. `GolemSigner` interface + `MockSigner`
2. Research: Ark SDK delegation primitive (see docs/research-priorities.md #1)
3. Research: `@arkade-os/boltz-swap` testnet integration
4. Testnet wallet creation + boarding via MockSigner
5. VTXO monitoring + refresh agent with dynamic safety margins
6. VTXO consolidation during refresh rounds
7. OOR settlement + exposure limits (10% balance or 0.01 BTC, whichever larger)
8. Safe harbor address setup + emergency exit flow
9. Wallet UI (minimal — balance, txs, agent status. NOT a developer dashboard)
10. Railway template with /setup wizard

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

## Reference Docs

Read these when you need deeper context:
- `docs/architecture.md` — Three-component model, signer interface, security model, agent deployment
- `docs/ark-reference.md` — Ark protocol specifics, VTXO lifecycle, rounds, fees, Boltz integration
- `docs/research-priorities.md` — Open questions ordered by criticality
- `docs/vision.md` — Long-term product direction (neobank aspirations, team, market)
- `docs/sdk-identity-analysis.md` — Ark SDK Identity interface analysis, GolemIdentity bridge design
