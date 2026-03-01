# Safe Harbor Address — Design Document

**Date:** 2026-02-26
**Status:** Design review v2 (pre-implementation)
**Phase:** Phase 1 requirement (Task #8)

---

## Overview

Safe harbor is an on-chain Bitcoin address the user provides at wallet setup. When things go wrong — ASP down, agent failing, VTXOs approaching expiry — the agent exits funds to this address. It's the equivalent of Lightning's force-close: a last resort that always works.

## Exit Paths (SDK Analysis)

There are exactly two exit mechanisms in the Ark SDK. No simpler alternatives exist — `sendBitcoin()` only sends to Ark addresses, not on-chain.

### Path 1: Cooperative Offboard — `Ramps.offboard()`

**What it does:** Exits VTXOs to an on-chain Bitcoin address via the next ASP settlement round.

**Signing required:** YES — three signing operations:
1. `identity.sign(proof)` — register intent signature (wallet.js:969)
2. `identity.sign(settlementPsbt, [i])` — sign settlement PSBT for boarding UTXOs (wallet.js:789)
3. `identity.sign(forfeitTx, [0])` — sign forfeit transactions for VTXO inputs (wallet.js:840)

**ASP required:** YES — the ASP constructs the settlement transaction and coordinates the round. If ASP is unreachable, offboard fails immediately at the event stream connection (wallet.js:742). Intent is cleaned up, user can retry.

**ReadonlyWallet compatible:** NO — `settle()` only exists on `Wallet`, not `ReadonlyWallet`.

**Speed:** Next settlement round (~1-2 min on mutinynet, ~5 min mainnet).

**When to use:** ASP is online, agent has signing capability.

### Path 2: Unilateral Exit — `Unroll.Session` + `Unroll.completeUnroll()`

**What it does:** Broadcasts the pre-signed VTXO transaction tree on-chain, waits for the CSV timelock to expire, then spends the output to the safe harbor address.

This is a multi-step process:

**Step A — Unroll tree broadcast (`Unroll.Session.create()` + iteration):**
- Signing required: NO for the tree transactions themselves (pre-signed by ASP at VTXO creation time)
- Signing required: YES for `AnchorBumper.bumpP2A()` — the CPFP child transaction that fee-bumps the tree broadcast (onchain.js:188). Uses the OnchainWallet's identity + on-chain UTXOs.
- ASP required: NO — pre-signed txs come from the indexer
- ReadonlyWallet compatible: NO (AnchorBumper calls `identity.sign()`)

**Step B — CSV path spend (`Unroll.completeUnroll()`):**
- Signing required: YES — `wallet.identity.sign(tx)` signs the CSV branch spend (unroll.js:218)
- ASP required: NO — purely on-chain, only needs blockchain confirmation
- ReadonlyWallet compatible: NO — method signature requires `Wallet`

**Speed:** Slow. Each branch tx needs on-chain confirmation, then CSV timelock must expire (hours to days), then final spend needs confirmation. During fee spikes, each confirmation could take hours.

**When to use:** ASP is down or unresponsive. Emergency only — this is the nuclear option.

### Path 3: There is no Path 3

Searched for `withdraw`, `exit`, `sweep`, `sendOnchain` in the SDK. Nothing else exists. The two paths above are it.

## Signing Requirements Summary

| Operation | Signing | ASP | ReadonlyWallet | Speed |
|-----------|---------|-----|----------------|-------|
| `Ramps.offboard()` | YES (3 sigs) | YES | NO | ~minutes |
| `Unroll.Session` iterate | NO (pre-signed) | NO | YES (iteration only) | |
| `AnchorBumper.bumpP2A()` | YES (1 sig) | NO | NO | immediate |
| `Unroll.completeUnroll()` | YES (1 sig) | NO | NO | after CSV timelock |

**Both exit paths require the wallet's signing key.** There is no read-only exit.

## OnchainWallet and Identity

The SDK's `OnchainWallet` implements the `AnchorBumper` interface. It manages on-chain UTXOs for fee bumping during unilateral exit.

**Factory:** `OnchainWallet.create(identity: Identity, networkName: NetworkName, provider?: OnchainProvider)` (onchain.d.ts:32)

**Same Identity as Wallet:** YES — `OnchainWallet` accepts the same `Identity` interface used by the main Ark `Wallet`. In Phase 1, Golem uses the same `GolemIdentity` (backed by MockSigner/ServerSigner) for both. Same keypair, but OnchainWallet derives a separate P2TR address (`onchainP2TR`) from it for managing on-chain coins.

**No separate key derivation path needed.** One keypair, two address spaces: the Ark address (for VTXOs) and the on-chain P2TR address (for fee-bump UTXOs).

## On-Chain Reserve (Hard Requirement)

The unilateral exit path requires `AnchorBumper.bumpP2A()`, which spends on-chain UTXOs to create CPFP fee-bump transactions. If all funds are boarded into Ark (our default flow), the AnchorBumper has no on-chain coins — unilateral exit is impossible.

**This is a known SDK constraint, not an open question.** `OnchainWallet` needs funded on-chain UTXOs for P2A fee bumping during unroll.

### Reserve calculation

Each unroll broadcasts one transaction per tree level from the user's VTXO leaf to the round root. Each broadcast requires one P2A fee-bump child transaction.

**VTXO tree structure:** The Arkade ASP constructs variable-depth trees. The SDK's `TxTree` is an n-ary tree (`Map<outputIndex, TxTree>` children), not binary. Tree depth depends on the number of participants in the round. No hardcoded depth constants exist in the SDK — it's ASP-determined.

**Conservative estimate for reserve per VTXO:** Assume tree depth of 4-6 levels (typical for Arkade mutinynet batches). Each P2A bump tx needs ~150-300 vbytes. At 10 sat/vbyte, each bump costs ~1,500-3,000 sats. Per VTXO: ~6,000-18,000 sats for the full tree path.

**Per-VTXO reserve formula:**

```
reserve_per_vtxo = tree_depth * bump_tx_size * fee_rate
                 = 6 * 250 * 10  (conservative defaults)
                 = 15,000 sats per VTXO
```

**Total reserve = reserve_per_vtxo * vtxo_count**

For a provider like Marcus with 30 small VTXOs from individual L402 payments: 30 * 15,000 = 450,000 sats (~$45). This is why aggressive VTXO consolidation during refresh rounds is critical — fewer VTXOs = cheaper emergency exit.

### Reserve enforcement

Three mechanisms:

1. **`golem init` retains a reserve:** After boarding, the agent holds back at least `MIN_ONCHAIN_RESERVE` sats (default: 50,000 sats) in the OnchainWallet. This covers the base case of a small number of VTXOs.

2. **Agent monitors reserve vs VTXO count:** On each poll cycle, the agent checks:
   ```
   required_reserve = vtxo_count * reserve_per_vtxo
   actual_reserve = onchainWallet.getBalance()
   if actual_reserve < required_reserve: emit 'reserve_low' warning
   ```

3. **Agent refuses to board the last N sats:** When processing inbound on-chain funds (boarding), the agent withholds enough to maintain the reserve. `wallet.onboard()` is called with `amount = available - required_reserve`, not the full balance.

### VTXO consolidation interaction

From CLAUDE.md, the agent consolidates when >10 VTXOs or smallest VTXO < dust threshold. This directly reduces exit cost. The reserve monitor reinforces this: if VTXO count grows and the on-chain reserve can't cover worst-case exit, the agent should prioritize consolidation at the next refresh round.

## Phase Implications

### Phase 1 (ServerSigner — hot key on server)

Both paths are available. The agent holds the signing key and can:
- Attempt cooperative offboard first (fast, preferred)
- Fall back to unilateral unroll if ASP is unreachable (slow, always works — provided on-chain reserve exists)

This is the straightforward case. The design below targets Phase 1.

### Phase 1.5 (Covenant — keyless server)

**Neither exit path works server-side.** The server has no signing key, so it cannot call `offboard()` or `completeUnroll()`.

Exit responsibility moves to the mobile app:
- Agent detects emergency, sends push notification to mobile app
- Mobile app holds the only signing key, executes the exit
- 30-day VTXO expiry gives ~weeks of buffer for the user to respond

This is a Phase 1.5 design problem, not Phase 1. For now, the server can handle exits directly.

## Proposed Design

### Config Changes

Add to `GolemConfig`:

```typescript
safeHarborAddress?: string;           // On-chain Bitcoin address. Required on mainnet.
safeHarborExitThresholdBlocks: number; // Default: 432 blocks (~72 hours at 10 min/block)
onchainReserveSats: number;           // Default: 50,000 sats
```

`safeHarborAddress` is **mandatory on mainnet**, **optional on testnet/mutinynet** (with persistent warnings).

`safeHarborExitThresholdBlocks` is the number of blocks remaining before VTXO expiry at which the agent begins attempting emergency exit. Default: 432 blocks (~72 hours). This accounts for:
- Multiple branch tx confirmations during unroll (each could take hours during fee spikes)
- CSV timelock wait (~10-24 hours depending on implementation)
- Final CSV spend confirmation
- Retry buffer if first attempts fail

The threshold is block-based, not time-based. The agent converts to wall-clock time dynamically using the recent block production rate (from `estimateExpiryFromBlockHeight()` in `src/agent/expiry.ts`). This aligns with the project's "dynamic safety margins, not static timers" principle.

### Address Validation

Uses `@scure/btc-signer` (already installed). `Address(network).decode(address)` provides:
- Full bech32/bech32m BCH checksum validation (witness addresses)
- Full base58check double-SHA256 validation (legacy addresses)
- Network discrimination (mainnet vs testnet vs regtest)
- Address type detection (P2PKH, P2SH, P2WPKH, P2WSH, P2TR)

Validation rules:
1. **Network match:** Reject mainnet address on testnet and vice versa. Use `NETWORK` for mainnet, `TEST_NETWORK` for testnet. For mutinynet (regtest), use custom `BTC_NETWORK` with `bech32: 'bcrt'`.
2. **Reject Ark addresses:** `tark1...` addresses fail automatically (wrong bech32 prefix).
3. **Legacy P2PKH warning:** If address starts with `1` (mainnet) or `m`/`n` (testnet), warn: "Legacy address detected. Segwit (bc1...) recommended for lower fees." Allow but warn.
4. **Accept P2WPKH, P2WSH, P2TR without warnings.** P2TR (bc1p...) is ideal.

No new dependencies needed. `@scure/btc-signer@2.0.1` handles everything.

### `golem init` Changes

After wallet creation, before saving config:

1. **Network check:**
   - If `--network mainnet`: prompt for safe harbor address, refuse to proceed without one
   - If `--network mutinynet` (default) or testnet: prompt for safe harbor address, allow skip with warning

2. Prompt: "Enter a safe harbor Bitcoin address (on-chain, cold storage recommended):"
3. Validate via `Address(network).decode()`:
   - Correct network (reject mismatched)
   - Valid checksum
   - Not an Ark address
   - Warn on legacy P2PKH
4. Display: "Emergency funds will be sent to: [address]"
5. If skipped (testnet only): "WARNING: No safe harbor address set. Run `golem safe-harbor <address>` before depositing significant funds."
6. **Retain on-chain reserve:** After initial boarding, withhold `onchainReserveSats` from the boarding amount. These stay in the `OnchainWallet` for AnchorBumper fees.

No seed phrase display in Phase 1 (key is stored in config). Seed phrase display is a Phase 1.5 concern.

### GolemWallet Changes

Add `OnchainWallet` management and exit method:

```typescript
// New fields
private onchainWallet: OnchainWallet;  // Manages on-chain reserve UTXOs

// New methods
async exitToSafeHarbor(
  safeHarborAddress: string,
  gateway?: { shutdown(): void },
  eventCallback?: (event: SettlementEvent) => void
): Promise<{ txid: string; method: 'offboard' | 'unroll' }>

async getOnchainReserveBalance(): Promise<number>

async getRequiredReserve(): Promise<{ required: number; vtxoCount: number; perVtxo: number }>
```

`exitToSafeHarbor()` logic:

1. **Shut down L402 gateway immediately** — `gateway.shutdown()`. No new 402 challenges. Accepting payments during exit creates VTXOs that may never be claimable.
2. Try `Ramps.offboard(safeHarborAddress, feeInfo)` (cooperative path)
3. If offboard succeeds, return `{ txid, method: 'offboard' }`
4. If offboard fails (ASP unreachable, timeout after 60s), fall through to unilateral
5. Check on-chain reserve balance. If insufficient for AnchorBumper, throw with diagnostic: "Unilateral exit requires on-chain reserve. Current: X sats, Required: Y sats for Z VTXOs."
6. Create `OnchainWallet` as `AnchorBumper`. For each VTXO, run `Unroll.Session.create()` → iterate → broadcast with bump.
7. After all tree txs broadcast, wait for CSV timelocks, then `Unroll.completeUnroll()`
8. Return `{ txid, method: 'unroll' }`

### RefreshAgent Changes

Add emergency exit tracking and reserve monitoring:

```typescript
interface EmergencyState {
  consecutiveRefreshFailures: number;
  lastSuccessfulRefresh: Date | null;
  emergencyExitAttempted: boolean;
}
```

On each poll cycle:
1. **Reserve check:** Compare `onchainWallet.getBalance()` against `vtxoCount * reservePerVtxo`. If insufficient, emit `reserve_low` warning with required vs actual amounts.
2. **Expiry check:** Get all VTXOs. Convert closest expiry to blocks remaining using recent block production rate.
3. If closest expiry in blocks < `safeHarborExitThresholdBlocks` AND config has `safeHarborAddress` AND last refresh failed:
   - Emit `emergency_exit_triggered` event
   - Call `wallet.exitToSafeHarbor(config.safeHarborAddress, gateway)`
   - On success: emit `emergency_exit_completed`, stop polling
   - On failure: emit `emergency_exit_failed`, keep trying each cycle
4. If refresh succeeds, reset `consecutiveRefreshFailures` to 0
5. **Consolidation pressure:** If `vtxoCount > 10` OR required reserve exceeds actual reserve, prioritize consolidation at next refresh round. This directly reduces emergency exit cost.

The agent does NOT exit just because refresh fails a few times. It only exits when VTXOs are approaching expiry AND refresh is failing. Transient ASP downtime is tolerated — the 72-hour (432-block) threshold gives days of buffer for recovery.

### Gateway Shutdown During Exit

**Mandatory, not optional.** When `exitToSafeHarbor()` is called:
1. First action: `gateway.shutdown()` — stop issuing 402 challenges, reject new requests with 503
2. Then proceed with exit
3. Accepting payments during exit creates new VTXOs that may never be claimable (cooperative offboard takes them all, but if we fall through to unilateral, newly-arrived VTXOs may not have pre-signed trees yet)

The gateway object is passed into `exitToSafeHarbor()` so the wallet layer can shut it down before beginning the exit process.

### CLI Changes

```
golem safe-harbor              Show current safe harbor address + reserve status
golem safe-harbor <address>    Update safe harbor address (validates format + network)
golem exit                     Manually trigger safe harbor exit (confirmation prompt)
golem reserve                  Show on-chain reserve balance vs required
```

`golem exit` is for manual emergency use. Calls `exitToSafeHarbor()` directly. Prompts "This will exit ALL funds to [address]. Type 'exit' to confirm:"

### Server API Changes

```
GET  /api/safe-harbor          Returns safe harbor address + reserve status + exit state
POST /api/exit                 Manually trigger safe harbor exit (requires confirmation token)
```

The POST endpoint requires a confirmation token (generated and displayed in server logs on startup) to prevent accidental triggers.

## What This Does NOT Cover

- **Phase 1.5 keyless exit:** When the server has no signing key, exit requires the mobile app. Design deferred to Phase 1.5.
- **Partial exit:** Exiting only the most critical VTXOs while keeping others in Ark. Could optimize fees but adds complexity. Start with "exit everything."
- **Safe harbor address rotation:** Changing the address after setup. `golem safe-harbor <new-address>` handles this. No need to keep old address as fallback.
- **Fee rate estimation for reserve:** Current design uses a static 10 sat/vbyte estimate for reserve calculation. Could be improved with dynamic fee estimation (mempool.space API), but this is a P2 optimization (research-priorities #9).
