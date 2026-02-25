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
│ MOBILE: <0.21 BTC   │     │ • Minimal delegation │     │                     │
│ HARDWARE: ≥0.21 BTC │     │   credential only    │     │                     │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
```

## Security Model

| Compromised | Attacker Gets | Attacker Can't Do |
|---|---|---|
| Agent | Delegation cred (refresh-scoped), balance visibility | Send to arbitrary addresses, spend freely |
| Signer | Signing capability for all operations | Propose txs without agent+ASP |
| ASP | Transaction history, VTXO data | Steal funds — user can exit unilaterally |
| Agent + ASP | Depends on delegation scope | If refresh-to-same-owner: still can't redirect funds |

**WARNING:** This table assumes delegation is scoped to "refresh to same owner." If delegation allows refresh to arbitrary destinations, Agent compromise = fund theft risk. This is research priority #1.

## Signer Interface

```typescript
interface GolemSigner {
  getSignerInfo(): Promise<SignerInfo>;
  getPublicKey(): Promise<Buffer>;
  signTransaction(unsignedTx: UnsignedTransaction): Promise<SignedTransaction>;
  getDelegationCredential?(): Promise<DelegationCredential>;
  ping(): Promise<SignerStatus>;
}

interface SignerInfo {
  type: 'mobile' | 'hardware';
  deviceName?: string;
  supportsAutomation: boolean;
  delegationSupported: boolean;
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
├── MobileSigner
│   ├── iOSSigner (Keychain + SE encryption + FaceID)
│   └── AndroidSigner (Keystore + TEE + biometric)
├── HardwareSigner
│   ├── TapsignerSigner (via cktap / NFC) ← default upgrade device
│   ├── TrezorSigner (via trezorctl)
│   ├── ColdcardSigner (via ckcc)
│   ├── LedgerSigner (via HID)
│   ├── KeystoneSigner (via QR)
│   └── PassportSigner (via QR/microSD)
├── DelegationSigner (wraps any signer, uses Ark delegation for refresh)
└── MockSigner (prototype — keys in memory behind the interface)
```

For the PoC: implement `MockSigner` only. Interface boundary must be real.

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

## Agent Deployment (User-Owned)

The agent is NOT a Golem cloud service. Each user deploys their own.

### Railway Template (Primary)
```
User clicks "Deploy on Railway"
  → Railway builds container
  → User visits /setup in browser
  → Wizard collects: wallet pubkey, Ark server URL, safe harbor address, delegation cred
  → Agent starts monitoring VTXOs
  → ~$5-8/month on Railway
```

Pattern proven by OpenClaw Railway templates. See: https://railway.com/deploy/openclaw

### Security for Railway deployment
- Delegation credential encrypted at rest on Railway volume
- Setup wizard password-protected
- No master key material touches Railway
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
| Signer offline near expiry | Emergency alerts. Use delegation if available. |
| All else fails near expiry | Force-withdraw to safe harbor on-chain. |

## Business Model

- **Free / Open Source:** Agent software + VTXO refresh. User self-hosts or pays Railway directly.
- **Pro ($10-20/mo):** Managed hosting, premium alerting, consolidation optimization.
- **Premium ($30-50/mo):** Pro + encrypted tx tree backup (S3), anomaly detection, DeFi automation, free Tapsigner.
