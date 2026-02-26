# Boltz Reverse Swap Lifecycle — Consolidated Research Report

**Date:** 2026-02-26
**ASP Status:** mutinynet.arkade.sh is back online (200 OK). Live payment test (Q6/Q7) blocked by Voltage LND macaroon auth failure ("signature mismatch after caveat verification" — macaroon likely rotated). Code analysis answers are definitive regardless. To re-run: provide a fresh `VOLTAGE_MACAROON` and run `npx tsx tests/research/q6-q7-lightning-lifecycle.ts`.

---

## Question 1 (CRITICAL): What happens to a paid-but-unclaimed Boltz reverse swap?

### Answer

**Boltz creates a VHTLC (Virtual HTLC) on Ark, but it is NOT visible to ReadonlyWallet.**

The complete lifecycle:

```
1. createLightningInvoice() → Boltz creates a HOLD invoice (not standard)
2. Consumer pays the hold invoice → HTLC held by Boltz LND
3. Boltz creates VHTLC on Ark at the lockup address
4. Status transitions: swap.created → transaction.mempool → transaction.confirmed
5. WITHOUT waitAndClaim():
   - VHTLC sits at lockup address (NOT user's address)
   - Consumer's Lightning HTLC stays held (preimage not released)
   - After ~2 days: Boltz can refund cooperatively (refund CLTV expires)
   - After ~20 days: User can claim unilaterally (unilateralClaim CSV)
   - After ~40 days: Boltz can refund unilaterally without receiver
```

### Sub-answers

| Question | Answer |
|----------|--------|
| Does Boltz create a VTXO? | Yes — a VHTLC (special VTXO with HTLC tapscript) at the lockup address |
| Visible via readonlyWallet.getVtxos()? | **NO** — VHTLC has a different script than user's address |
| Visible via readonlyWallet.getBalance()? | **NO** — same reason |
| Where do funds sit? | In a VHTLC at Boltz's lockup address on Ark |
| Unclaimed swap timeout? | ~2 days for cooperative refund, ~20 days for unilateral claim |
| Unclaimed = Boltz keeps funds? | **NO** — Boltz refunds both sides (Lightning + Ark lockup) |

### Critical L402 Implication

**The hold invoice means the consumer does NOT get the preimage from Lightning until the claim happens.** This breaks the standard L402 flow where the consumer gets the preimage via Lightning payment settlement.

The current working L402 flow requires the gateway to have a hot key and call `waitAndClaim()` to claim the VHTLC, which reveals the preimage to Boltz, which then settles the hold invoice, which sends the preimage back to the consumer on Lightning.

---

## Question 2: What does waitAndClaim() actually do?

### Answer

```
STEP 1: Monitor swap via WebSocket
  → wss://api.boltz.mutinynet.arkade.sh/v2/ws
  → Subscribe to swap.update for swapId

STEP 2: On "transaction.mempool" or "transaction.confirmed"
  → claimVHTLC(pendingSwap) triggered

STEP 3: claimVHTLC()
  a. Get preimage from pendingSwap.preimage
  b. Get 3 public keys: ours, Boltz refundPublicKey, ASP signerPubkey
  c. Reconstruct VHTLC script, verify lockup address matches
  d. Find VHTLC in indexer: indexerProvider.getVtxos({scripts: [vhtlcScript]})
  e. Wrap identity with claimVHTLCIdentity (injects preimage into witness)
  f. if (isRecoverable(vtxo)):
       → joinBatch() — join next Ark round (3 sigs: intent, delete, forfeit)
     else:
       → claimVHTLCwithOffchainTx() — direct settlement (2 sigs: arkTx, checkpoint)

STEP 4: On "invoice.settled" → waitAndClaim() resolves with {txid}
```

### Key Finding

**Claiming is purely an Ark-side operation.** No Boltz-specific claim endpoint. Boltz detects the claim by watching the Ark commitment TX and extracting the preimage from the witness data.

---

## Question 3: Boltz reverse swap timeout

### Answer (from live test)

```
BOLTZ REVERSE SWAP TIMEOUT:
- refund: CLTV absolute timestamp, ~2 days from creation
  (Boltz + ASP can cooperatively refund after this)
- unilateralClaim: CSV relative, 1,728,000 seconds = ~20 days
  (User can claim without Boltz cooperation after this)
- unilateralRefund: CSV relative, 1,728,000 seconds = ~20 days
  (User can refund without Boltz cooperation)
- unilateralRefundWithoutReceiver: CSV relative, 3,456,000 seconds = ~40 days
  (Boltz can refund without receiver cooperation)

On mutinynet: Same values (timestamps, not blocks)
On mainnet: Expected similar durations (protocol-level, not network-specific)
```

### Practical claim window

| Window | Duration | Who can act |
|--------|----------|------------|
| Normal claim | 0 — 2 days | Claim with master key + server |
| Cooperative refund | 2+ days | Boltz + ASP cooperate to refund |
| Unilateral claim | 20+ days | User alone (expensive, requires on-chain TX) |
| Boltz unilateral refund | 40+ days | Boltz alone |

**For deferred claiming: the mobile app MUST claim within ~2 days.**

---

## Question 4: Can claiming be separated from waitAndClaim()?

### Answer: YES

**Deferred claiming is fully supported.** The pendingSwap data is plain JSON, serializable, and contains everything needed for a later claim.

### Data to persist

```json
{
  "id": "swap_id",
  "preimage": "hex_preimage",     // CRITICAL — claim secret
  "request": {
    "claimPublicKey": "hex",       // For script reconstruction
    "preimageHash": "hex"          // For verification
  },
  "response": {
    "lockupAddress": "tark1...",   // VHTLC location
    "refundPublicKey": "hex",      // Boltz key for script
    "timeoutBlockHeights": {...}   // For script reconstruction
  }
}
```

### Claiming from mobile app

```typescript
// Mobile app (has master key):
const wallet = await Wallet.create({ identity: new SingleKey(PRIVATE_KEY), ... });
const arkadeLightning = new ArkadeLightning({ wallet, swapProvider });
const pendingSwap = JSON.parse(serverStoredSwapData);
const { txid } = await arkadeLightning.waitAndClaim(pendingSwap);
```

### Gotchas

1. **Must claim within ~2 days** before Boltz cooperative refund window
2. **Preimage must be stored securely** — it's the claim secret
3. **Same keypair required** — the claiming wallet must have the same key
4. **Hold invoice**: Consumer doesn't get preimage until claim happens

---

## Question 5: OOR or round-based settlement?

### Answer: BOTH (context-dependent)

```
if (isRecoverable(vtxo))
  → joinBatch() → IN-ROUND CLAIM
  → Waits for next Ark batch, participates in MuSig2 signing
  → VTXO created when round commits

else
  → claimVHTLCwithOffchainTx() → OFF-CHAIN TX
  → Direct settlement via buildOffchainTx()
  → Submits to ASP for server cosignature
```

Neither is a standard OOR "sendBitcoin" operation. Both are specialized VHTLC claim flows.

---

## Question 6: Lightning HTLC lifecycle vs. Ark VTXO lifecycle

### Answer

```
LIGHTNING HTLC LIFECYCLE:
1. SDK generates preimage + hash
2. Boltz creates HOLD invoice with the hash
3. Consumer pays → HTLC held by Boltz (Boltz can't settle without preimage)
4. Boltz creates VHTLC on Ark (lockup)
5. User claims VHTLC → preimage revealed in Ark TX witness
6. Boltz extracts preimage from Ark TX
7. Boltz settles hold invoice → preimage flows back to consumer
8. Consumer receives preimage from LND

IF UNCLAIMED:
- Lightning HTLC times out → consumer refunded
- VHTLC expires → Boltz refunds via refund path
- NET RESULT: Nobody keeps the money. Both sides refunded.
```

### Critical finding for L402

**The consumer does NOT get the preimage until the claim happens on Ark.** In a standard L402 flow (with LND), the payee's node settles the invoice immediately, and the preimage flows back to the payer. In Golem's Boltz-based flow, the preimage only flows back after the VHTLC claim.

This means the receive-only gateway architecture has a fundamental issue with L402: **the consumer can't construct the L402 token without the preimage, and the preimage isn't released without a claim.**

### Workaround options

1. **Server-side preimage sharing:** Gateway already has the preimage (generated locally). Gateway monitors Boltz status for `transaction.mempool` (confirms payment), then shares preimage with consumer directly (e.g., polling endpoint).

2. **Separate claim hot key:** Small hot key on server JUST for Boltz claims. Not the wallet master key. Limits exposure.

3. **Hybrid architecture:** Server has hot key initially (Tier 0a), auto-sweeps to safe harbor above threshold. L402 claims work normally during this phase.

---

## Question 7: Can we observe VTXOs from ReadonlyWallet?

### Answer: NO (for VHTLC), YES (for claimed VTXOs)

```
VHTLC (unclaimed):
  - Located at: Boltz lockup address (different from user address)
  - readonlyWallet.getVtxos(): NOT visible (queries user's scripts)
  - readonlyWallet.getBalance(): NOT visible
  - notifyIncomingFunds(): NOT triggered
  - To detect: query indexerProvider.getVtxos({scripts: [vhtlcScript]})
    (requires reconstructing the VHTLC script from swap response data)

After claim:
  - VTXO is a standard Ark VTXO at user's address
  - readonlyWallet.getVtxos(): VISIBLE
  - readonlyWallet.getBalance(): VISIBLE
  - notifyIncomingFunds(): WILL trigger
```

---

## Architecture Implications

### The L402 hold invoice problem

The receive-only gateway (no master key) has a fundamental chicken-and-egg problem with L402:

1. Consumer pays invoice → payment held by Boltz
2. Consumer needs preimage to form L402 token
3. Preimage only released after claim → claim needs master key
4. Gateway is read-only → can't claim → consumer never gets preimage

### Recommended architecture: Tier 0 sub-tiers (revised)

| Sub-tier | Server key | L402 works? | Claiming | Risk |
|----------|-----------|-------------|----------|------|
| **0a: Hot key** | Yes (encrypted) | Yes | Server claims immediately | Hot key exposure |
| **0b: Auto-sweep** | Yes + sweep | Yes | Server claims + sweeps above threshold | Limited exposure |
| **0c: Preimage-sharing** | No master key | Modified L402 | Server shares preimage directly after payment confirmation | Zero key risk, modified protocol |
| **0d: Deferred claim** | No master key | No (consumer times out) | Mobile claims within 2 days | Consumer UX issue |

### Option 0c detail (preimage-sharing)

```
Client → GET /api → 402 + invoice + macaroon
Client → pays invoice via Lightning
  (payment held by Boltz — consumer's LND waiting for preimage)
Gateway → monitors Boltz WebSocket → "transaction.mempool"
Gateway → knows payment received
Client → GET /api/preimage?hash=xxx → gateway returns preimage
Client → GET /api + Authorization: L402 macaroon:preimage → 200
  (meanwhile, Boltz VHTLC unclaimed, expires in 2 days)
  (mobile app claims within 2-day window, sats arrive as VTXO)
```

This is architecturally clean but modifies the L402 protocol. Standard L402 clients (like lnget) would need modification.

### Recommended path

**Start with Tier 0a/0b (hot key + auto-sweep).** This is the simplest architecture that works with standard L402. The hot key risk is mitigated by:
1. AES-256 encryption at rest
2. Auto-sweep above configurable threshold (e.g., 100,000 sats)
3. Safe harbor address for sweep target
4. OOR exposure limits

Phase 2: Explore Tier 0c (preimage-sharing) if zero-key-risk is required.
