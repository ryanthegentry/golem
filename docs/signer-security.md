# Architecture Reference

## Three-Component Model

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

## Security Model

| Compromised | Attacker Gets | Attacker Can't Do |
|---|---|---|
| Agent (Phase 1, hot key) | Signing capability for balance up to spending caps | Exceed spending caps, access hardware-tier funds |
| Agent (Phase 1.5, covenant) | Receive-only capability, balance visibility | Sign anything — server has no key. DoS only. |
| Signer (mobile/HW) | Signing capability for all operations | Propose txs without agent+ASP |
| ASP | Transaction history, VTXO data | Steal funds — user can exit unilaterally |
| Agent + ASP (Phase 1.5) | Balance visibility, receive-only | Still can't spend — no signing key on server |

**Phase 1 security framing:** Hot key on server is the same security model as every Lightning node. Pragmatic, not apologetic. Acceptable for testnet and small mainnet amounts.

**Phase 1.5 target:** Covenant-based keyless receive eliminates the signing key from the server entirely. See "Covenant-Based Receive" section below.

## Signer Interface

```typescript
interface GolemSigner {
  getSignerInfo(): Promise<SignerInfo>;
  getPublicKey(): Promise<Buffer>;
  signTransaction(unsignedTx: UnsignedTransaction): Promise<SignedTransaction>;
  ping(): Promise<SignerStatus>;
}

interface SignerInfo {
  type: 'mobile' | 'hardware' | 'agent' | 'server' | 'mock';
  deviceName?: string;
  supportsAutomation: boolean;
  maxAutoAmount?: number;
}

interface SignerStatus {
  available: boolean;
  lastSeen: Date;
  batteryLevel?: number;
  firmwareVersion?: string;
}
```

**Implementation hierarchy:**
```
GolemSigner (interface)
├── MobileSigner (Tier 1: phone, biometric-gated, THE master key for providers)
│   ├── iOSSigner (Keychain + SE encryption + FaceID)
│   └── AndroidSigner (Keystore + TEE + biometric)
├── HardwareSigner (Tier 2: ≥0.21 BTC)
│   ├── TapsignerSigner (via cktap / NFC) ← default upgrade device
│   ├── TrezorSigner (via trezorctl)
│   ├── ColdcardSigner (via ckcc)
│   ├── LedgerSigner (via HID)
│   ├── KeystoneSigner (via QR)
│   └── PassportSigner (via QR/microSD)
├── AgentSigner (hot key with spending caps, for agent wallets that SPEND)
├── ServerSigner (Phase 1: bootstrap hot key encrypted on disk, AES-256, for Railway/self-hosted)
├── MockSigner (prototype — keys in memory behind the interface)
└── [DelegateIdentity — deferred, Phase 2+ if ever needed]
```

For Phase 1: `MockSigner` (testnet) and `ServerSigner` (production Tier 0). Interface boundary is real from day one.

### Deferred: DelegateIdentity

**Status: Deferred.** Delegation is no longer the target architecture for Phase 1.5. Covenant-based keyless receive is the path. Delegation becomes relevant only if covenants slip significantly or for advanced multi-party custody scenarios in Phase 2+.

For the record, the delegate is an active round participant that:
- Holds its own keypair (for MuSig2 tree signing)
- Stores user's pre-signed intent (BIP322 ownership proof)
- Stores user's pre-signed tapScriptSig for forfeit TX (`SIGHASH_ALL|ANYONECANPAY`)
- Combines signatures during the round's forfeit TX signing phase
- Delegation is per-VTXO, per-refresh-cycle — requires periodic reprovisioning by the master key holder

Low-level primitives (`Intent`, `buildForfeitTx`, `CLTVMultisigTapscript`, `combineTapscriptSigs`) exist in the published SDK. High-level delegation orchestration is only on the unpublished `delegate` branch of `arkade-os/ts-sdk`. Since delegation requires monthly provisioning from the phone anyway, "just refresh from the app" achieves the same outcome with dramatically less complexity.

## Covenant-Based Receive (Phase 1.5)

**Target architecture for keyless Lightning receive.** Gated on Arkade introspection opcodes. Not new infrastructure — it's a mode of the existing agent/SwapManager.

### The Problem

When the L402 gateway receives a Lightning payment via Boltz reverse swap, claiming the VHTLC requires the wallet's signing key. Without a key on the server, the gateway can issue 402 challenges and detect payment, but can't claim the sats.

### The Solution

A covenant-restricted VHTLC claim script using three specific Arkade introspection opcodes:

- `OP_INSPECTOUTPUTSCRIPTPUBKEY` (OP_SUCCESS209) — verifies output pays to user's exact taproot address
- `OP_INSPECTOUTPUTVALUE` (OP_SUCCESS207) — verifies output contains correct amount
- `OP_INSPECTNUMOUTPUTS` (OP_SUCCESS213) — constrains transaction to single output

These are the same opcodes Arkade already uses internally for `unroll.hack` shared output scripts. No compiler needed — raw tapscript byte construction, ~50-60 bytes.

### Claim Daemon

A mode of the existing SwapManager/agent:
1. Detects incoming VHTLCs (Boltz reverse swap completion)
2. Constructs covenant-valid claim transaction using just the preimage (no signing)
3. Submits to ASP
4. Sats arrive as VTXO in user's wallet

### Impact on Provider Flow (Marcus)

With covenants, server NEVER holds a signing key:
1. `golem init` generates keypair, shows seed phrase, deletes key from server
2. Server runs in receive-only mode forever
3. Claim daemon detects incoming VHTLCs, constructs covenant-valid claims
4. Mobile app holds the only signing key, handles refresh when user opens it
5. 7-day VTXO expiry (mainnet) = natural onboarding funnel to the mobile app

### Open Questions

- Can the Arkade-Boltz gateway support covenant-restricted VHTLCs?
- Does `createLightningInvoice()` require the signing key, or just a pubkey?

## 2-of-2 Multisig (Validated, Deferred)

An Ark Labs maintainer proposed: 2-of-2 where one key is agent (server), one key is Alice (phone), with Alice-only timelock sweep.

**VTXO script:**
- `3-of-3: agent + alice + ASP` — collaborative spending path
- `alice + CSV` — Alice's unilateral exit after timelock

Arkade's ASP enforcement model allows custom Bitcoin scripts as long as they respect the VTXO paradigm.

**Status:** Validated design, deferred. More complex than covenant path (still puts a key on server, requires both CLI and app to exist before creating VTXO scripts). Covenant path is cleaner for the provider use case and arrives sooner. 2-of-2 remains an option for Phase 2+ or as fallback if covenants slip.

## Tiered Security

### Tier 1: Mobile (< 0.21 BTC)
- secp256k1 keypair generated in software
- Encrypted with Secure Enclave (iOS) or Keystore (Android) protected key
- Signing happens in app memory (not inside secure element — SE doesn't support secp256k1)
- Gated behind biometric auth
- Industry standard: same as Phoenix, Breez, Casa mobile key

### Tier 2: Hardware (≥ 0.21 BTC)
- Default: Tapsigner (~$20 NFC card). secp256k1 signing inside secure element. PSBT support.
- Tapsigner limitation: no screen (can't verify tx on device). Acceptable for refresh, weaker for large manual transfers.
- Also supported: Coldcard, Trezor, Ledger, Keystone, Passport

### Threshold Enforcement
- 80%: Gentle suggestion, offer free Tapsigner
- 95%: Stronger prompt with setup guide
- 100%: Hard block on inbound funding. No override. Withdraw or upgrade.
- Price appreciation: 7-day grace period

### Upgrade Paths

**Provider path (Marcus — API monetization):**
Server runs receive-only after init. User imports seed into mobile app. No sweep needed — server continues receive-only via covenant claim daemon (Phase 1.5). Mobile app handles refresh when user opens it. 7-day VTXO expiry (mainnet) is the conversion event that drives mobile app adoption.

**Agent path (Jake — AI agent spending):**
Agent wallet has hot key (AgentSigner) with spending caps. When balance grows to justify hardware, user sweeps to mobile wallet. No delegation credential needed — mobile app handles refresh directly.

## Agent Deployment (User-Owned)

The agent is NOT a Golem cloud service. Each user deploys their own.

### Railway Template (Primary)
```
User clicks "Deploy on Railway"
  → Railway builds container
  → User visits /setup in browser
  → Wizard collects: wallet pubkey, Ark server URL, safe harbor address
  → Agent starts monitoring VTXOs
  → ~$5-8/month on Railway
```

Pattern proven by comparable Railway templates.

### Security for Railway deployment
- **Phase 1 (ServerSigner):** Hot key encrypted with AES-256, derived from user password. Key is present for all operations. Same security model as every LN node. Acceptable for small amounts.
- **Phase 1.5 (covenant):** Server has NO signing key. Runs in receive-only mode. Claim daemon handles Lightning receive via covenants. The strongest security model — nothing to steal from the server.
- Setup wizard password-protected
- User can export and migrate to self-hosted Docker

## Safe Harbor Address

**Required at wallet setup.** User provides a Bitcoin on-chain address (ideally cold storage). All emergency exits target this address. Analogous to Lightning force close.

- ASP goes down → agent prepares unilateral exit to safe harbor
- Agent compromised → user manually sweeps to safe harbor from signer
- Both down → user broadcasts pre-signed tx trees targeting safe harbor

## Core Agent Functions

### 1. VTXO Refresh
- Monitor expiry timestamps
- Dynamic safety margins based on mempool conditions (not static 48hr)
- Batch multiple VTXOs into single rounds

### 2. VTXO Consolidation (First-Class Safety Function)
- Combine small VTXOs during refresh rounds
- Prevent dust accumulation (minimum receive amounts)
- Trigger when >10 VTXOs or smallest VTXO < dust threshold at current fees
- Only consolidate when fee < estimated exit cost savings

### 3. OOR Settlement
- Auto-settle out-of-round payments at next round
- Max OOR balance: 10% of total or 0.01 BTC (whichever larger)
- Alert + reject if limit exceeded

### 4. Failure Handling

| Failure | Response |
|---|---|
| ASP offline | Alert user. Prepare unilateral exit to safe harbor. |
| Round fails | Retry next round. Log. |
| Agent offline | VTXOs safe (timelock buffer). Alert to restart. |
| Signer offline near expiry | Emergency alerts. Use mobile app directly. |
| All else fails near expiry | Force-withdraw to safe harbor on-chain. |

## Golem Service Directory

Public registry of L402-enabled APIs. Connects providers (`golem gateway`) with consumers (agent wallets, `golem pay`).

**Provider:** `golem gateway` auto-registers on startup. Directory stores endpoint URL, price, description, Ark address, uptime (heartbeat), response time, total requests, payment rails.

**Consumer:** `--agent-mode` wallets auto-discover and auto-pay listed services within spending caps. Search by keyword, category, price range, uptime.

**CLI:**
- `golem directory search <query>` — keyword search, `--category`, `--max-price`
- `golem directory list` — show registered services

**Phase 1:** Centralized REST API + web UI. **Phase 3:** Decentralized (Nostr-based registry federation).
