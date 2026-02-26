# Ark Protocol Reference

## How Ark Works

Ark is a Bitcoin L2. Users hold VTXOs (virtual UTXOs) off-chain. VTXOs expire on a ~4 week timelock. Users must refresh by participating in rounds with the Ark operator (ASP). Failure to refresh = operator reclaims funds = user loses bitcoin.

## Rounds

1. ASP initiates a round
2. Users (or agents via delegation) join
3. Together construct a transaction tree: one on-chain root, off-chain branch/leaf txs
4. Each VTXO is a leaf — a pre-signed path for unilateral on-chain claim
5. Users forfeit old VTXOs, receive new ones with fresh timelocks
6. Root transaction broadcast and confirmed on-chain

## VTXO Types

| Type | Created By | Trust Model | Golem Action |
|---|---|---|---|
| Board VTXO | On-chain deposit | Fully trustless | Initial funding |
| Refresh VTXO | Round participation | Fully trustless after confirmation | Agent manages these |
| Spend VTXO (OOR) | Out-of-round payment | Weaker — cosigned by operator | Auto-settle at next round, enforce exposure limits |

## Fee Optimization

```
VTXO created ←──────────────────────→ VTXO expires
     High fee                           Low fee
     Week 1     Week 2     Week 3     Week 4
                               ↑───────↑
                          Dynamic window:
                          Adjusted by mempool congestion
```

Refreshing closer to expiry = cheaper (operator's capital lockup shorter). Agent optimizes this against real-time mempool conditions.

## VTXO Consolidation

Users with many small VTXOs face expensive unilateral exit (each VTXO = separate on-chain tx). Agent consolidates during refresh rounds:
- Combine multiple small VTXOs into fewer larger ones
- Minimum economical VTXO size at 50 sat/vB ≈ 5,000 sats
- Below that = effectively dust on the exit path

## Unilateral Exit

If ASP goes down, users can claim on-chain using pre-signed transaction trees. Requirements:
- Pre-signed transaction tree data (lives on ASP, should be backed up)
- On-chain fees for potentially many transactions
- Must broadcast within the timelock window
- All exits target the safe harbor address

## Delegation Primitive (Arkade Intents)

**Status:** Live in arkd v0.7.0+ (Go server). Low-level primitives in published TS SDK. High-level orchestration on unpublished `delegate` branch only.

Delegation uses **Arkade Intents** — BIP322-style ownership proofs combined with partial forfeit transactions. This is NOT a "present a credential to the ASP" model. The delegate is an active round participant.

### How delegation works

1. **VTXO creation with delegation script:** User creates VTXOs with a 3-path tapscript:
   - `A+S` (Alice + Server): Normal spending
   - `A+CSV(exit)`: Alice's unilateral exit after timelock
   - `A+D+S+CLTV`: Delegation path (Alice + Delegate + Server) with absolute timelock

2. **Provisioning (master key online):** User pre-signs:
   - **Intent proof:** BIP322-style transaction proving VTXO ownership (`Intent.create()`)
   - **Partial forfeit TX:** Signed with `SIGHASH_ALL|ANYONECANPAY` (allows delegate to add connector input)
   - These artifacts are given to the delegate along with VTXO details

3. **Delegated refresh (master key offline):** Delegate:
   - Submits the pre-signed intent to join the round
   - Participates in MuSig2 tree signing with its own ephemeral key
   - Combines Alice's pre-signed tapScriptSig with its own signature on the forfeit TX
   - Adds a connector input to the forfeit TX and finalizes it

4. **Per-VTXO, per-cycle:** After each round, new VTXOs are created. The master key must come online to provision new intents for the next cycle.

### Delegation scope (confirmed by Tiero, Feb 25)

Delegation is constrained to "refresh to same owner" by design. The owner pre-signs a transaction to themselves — the delegate cannot change the output destination. Compromised delegate = DoS only (failing to refresh), NOT fund theft.

### SDK primitives available (v0.3.13)

| Primitive | Export | Status |
|-----------|--------|--------|
| `Intent.create(message, inputs, outputs)` | Yes | Usable |
| `buildForfeitTx(inputs, pkScript, locktime)` | Yes | Usable |
| `CLTVMultisigTapscript.encode({absoluteTimelock, pubkeys})` | Yes | Usable |
| `VtxoScript(scripts)` | Yes | Usable |
| `combineTapscriptSigs(signedTx, originalTx)` | Yes | Usable |
| High-level delegation flow | No | Only on unpublished `delegate` branch |

## Arkade Platform Roadmap (per Tiero, Feb 25, 2026)

| Capability | Status | Timeline |
|---|---|---|
| Delegation | Live in arkd v0.7.0+, primitives in TS SDK, orchestration on unpublished branch | Pending |
| Assets (stablecoins) | Current focus | Mid-March 2026 |
| Full opcodes | After assets | March-April 2026 |
| Swaps, lending, Fuji | Written, pending deploy | April-May 2026 |
| Cross-chain stablecoins | Parallel development | TBD |

Ark Labs explicitly wants third parties to build neobanks and fintechs on Arkade. Arkade Money is a reference wallet to validate UX before enabling ecosystem.

## Key Ecosystem Players

- **Ark Labs** — Protocol developers. Build Arkade (Go). Their wallet = Arkade Money.
- **Second** — SEPARATE company. Independent Ark implementation in Rust. Different team, different codebase.
- **Boltz** — Non-custodial swap provider. Lightning↔Bitcoin↔Liquid↔Rootstock. KYC-free.

## Boltz Integration (Onboarding)

`@arkade-os/boltz-swap` provides Lightning→Ark submarine swaps.

```javascript
import { Wallet, SingleKey } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

const swapProvider = new BoltzSwapProvider({
  apiUrl: 'https://api.boltz.mutinynet.arkade.sh',
  network: 'mutinynet',
  referralId: 'golem',
});

const arkadeLightning = new ArkadeLightning({ wallet, swapProvider });

// Receive: LN invoice → Boltz → Ark VTXO
const result = await arkadeLightning.createLightningInvoice({ amount: 50000 });
await arkadeLightning.waitAndClaim(result.pendingSwap);

// Send: Ark → Boltz → LN payment
await arkadeLightning.sendLightningPayment({ invoice: 'lnbc...' });

// Check limits before creating invoices
const limits = await arkadeLightning.getLimits();
```

Fees: ~0.1-0.5% depending on direction. Non-custodial. KYC-free.

## SDK Resources

- Ark Labs Wallet SDK: https://github.com/ArkLabsHQ/wallet-sdk
- Arkade Boltz integration: https://github.com/arkade-os/boltz-swap
- Ark Labs docs: https://docs.arklabs.xyz/
- Ark Protocol spec: https://ark-protocol.org/
- Bitcoin Optech on Ark: https://bitcoinops.org/en/topics/ark/

## Hardware Signer Resources

- Tapsigner protocol: https://github.com/coinkite/coinkite-tap-proto
- Tapsigner React Native: https://github.com/coinkite/cktap-protocol-react-native
- Tapsigner C++: https://github.com/coinkite/cktap-protocol-cpp
- Tapsigner FAQ: https://tapsigner.com/faq
- LND remote signer (reference architecture): https://docs.lightning.engineering/lightning-network-tools/lnd/remote-signing
- Casa security model: https://docs.casa.io/wealth-security-protocol
