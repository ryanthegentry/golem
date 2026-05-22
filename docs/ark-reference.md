# Ark Protocol Reference

## How Ark Works

Ark is a Bitcoin L2. Users hold VTXOs (virtual UTXOs) off-chain. VTXOs expire on a ~4 week timelock. Users must refresh by participating in rounds with the Ark operator (ASP). Failure to refresh = operator reclaims funds = user loses bitcoin.

## Rounds

1. ASP initiates a round
2. Users (or agents) join
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

**Status: Deferred for Golem.** Delegation is live in the Ark protocol but Golem is targeting covenant-based keyless receive (Phase 1.5) instead. Delegation becomes irrelevant for the provider use case once covenants ship. See `docs/signer-security.md` for the covenant design.

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

### Delegation scope

Delegation is constrained to "refresh to same owner" by design. The owner pre-signs a transaction to themselves — the delegate cannot change the output destination. Compromised delegate = DoS only (failing to refresh), NOT fund theft.

### Why deferred for Golem

Delegation requires monthly provisioning from the user's phone. "Just refresh from the app" achieves the same outcome with dramatically less complexity. With the covenant plan, the server doesn't need delegation if it never signs.

### SDK primitives available (v0.3.13)

| Primitive | Export | Status |
|-----------|--------|--------|
| `Intent.create(message, inputs, outputs)` | Yes | Usable |
| `buildForfeitTx(inputs, pkScript, locktime)` | Yes | Usable |
| `CLTVMultisigTapscript.encode({absoluteTimelock, pubkeys})` | Yes | Usable |
| `VtxoScript(scripts)` | Yes | Usable |
| `combineTapscriptSigs(signedTx, originalTx)` | Yes | Usable |
| High-level delegation flow | No | Only on unpublished `delegate` branch |

## Covenant Claim Scripts (Phase 1.5)

**Target architecture for keyless Lightning receive.** Gated on Arkade introspection opcodes.

### The Three Opcodes

Arkade's custom introspection opcodes enable covenant-restricted VHTLC claim scripts:

| Opcode | Number | Purpose |
|--------|--------|---------|
| `OP_INSPECTOUTPUTSCRIPTPUBKEY` | OP_SUCCESS209 | Verifies output pays to user's exact taproot address |
| `OP_INSPECTOUTPUTVALUE` | OP_SUCCESS207 | Verifies output contains correct amount |
| `OP_INSPECTNUMOUTPUTS` | OP_SUCCESS213 | Constrains transaction to single output |

These are the same opcodes Arkade already uses internally for `unroll.hack` shared output scripts. No compiler needed — raw tapscript byte construction, ~50-60 bytes.

### How It Works for Golem

1. Boltz reverse swap creates a VHTLC with a covenant-restricted claim path
2. Claim daemon (a mode of the existing SwapManager) detects the VHTLC
3. Constructs a claim transaction using just the preimage (no signing key needed)
4. Covenant opcodes verify the output pays to the user's address with the correct amount
5. ASP accepts the transaction — sats arrive as a VTXO

### Open Questions

- Can the Arkade-Boltz gateway support covenant-restricted VHTLCs?
- Does `createLightningInvoice()` require the signing key, or just a pubkey?

See also: [Arkade Contracts Deep Dive](https://docs.arkadeos.com/contracts/deep-dive)

## Other Agent Wallet Designs

Other agent-wallet-on-Ark designs use custodial-enclave tradeoffs. Golem's design target is self-custodial L402 receive with covenant claims, which has a different security model and operational profile.

## Arkade Platform Roadmap

| Capability | Status | Timeline |
|---|---|---|
| Delegation | Live in arkd v0.7.0+, primitives in TS SDK, orchestration on unpublished branch | Pending |
| Assets (stablecoins) | Current focus | Mid-March 2026 |
| Introspection opcodes | Required for covenant claims. Same opcodes used internally by `unroll.hack`. | "Before this quarter ends" = March 2026 |
| Full opcodes | After assets | March-April 2026 |
| Swaps, lending, Fuji | Written, pending deploy | April-May 2026 |
| Cross-chain stablecoins | Parallel development | TBD |

Ark Labs explicitly wants third parties to build neobanks and fintechs on Arkade. Arkade Money is a reference wallet to validate UX before enabling ecosystem.

## Key Ecosystem Players

- **Ark Labs** — Protocol developers. Build Arkade (Go). Their wallet = Arkade Money.
- **Second** — SEPARATE company. Independent Ark implementation in Rust. Different team, different codebase.
- **Boltz** — Non-custodial swap provider. Lightning↔Bitcoin↔Liquid↔Rootstock. KYC-free.
- **MoneyDevKit** — Different market entirely (serverless Lightning checkout for merchants, built on LDK). Not a competitor. Not tracking.

## Boltz Integration (Onboarding)

`@arkade-os/boltz-swap` provides Lightning↔Ark swaps.

**Arkade-Boltz gateway minimums and fees:**
- Minimum swap: **500 sats** both directions (NOT standard Boltz's 50,000)
- Submarine swap (Lightning→Ark): **0.01% fee**
- Reverse swap (Ark→Lightning): **0.4% fee**
- This makes per-request L402 payments economically viable ($0.002/request ≈ 3 sats)

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

## SDK Resources

- Ark Labs Wallet SDK: https://github.com/ArkLabsHQ/wallet-sdk
- Arkade Boltz integration: https://github.com/arkade-os/boltz-swap
- Ark Labs docs: https://docs.arklabs.xyz/
- Arkade Contracts Deep Dive: https://docs.arkadeos.com/contracts/deep-dive
- Ark Protocol spec: https://ark-protocol.org/
- Bitcoin Optech on Ark: https://bitcoinops.org/en/topics/ark/

## Hardware Signer Resources

- Tapsigner protocol: https://github.com/coinkite/coinkite-tap-proto
- Tapsigner React Native: https://github.com/coinkite/cktap-protocol-react-native
- Tapsigner C++: https://github.com/coinkite/cktap-protocol-cpp
- Tapsigner FAQ: https://tapsigner.com/faq
- LND remote signer (reference architecture): https://docs.lightning.engineering/lightning-network-tools/lnd/remote-signing
- Casa security model: https://docs.casa.io/wealth-security-protocol
