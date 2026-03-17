# Spec 10: RefreshAgent

## Purpose
Autonomous VTXO monitoring, renewal, consolidation, and emergency exit. Core value proposition of Golem — without this, VTXOs expire and users lose bitcoin.

## Rust SDK Mapping
No SDK equivalent for RefreshAgent — **must build entirely**. Uses:
- `client.list_vtxos()` → VTXO state
- `client.settle(rng)` → refresh VTXOs into next round
- `client.collaborative_redeem()` → cooperative exit
- `client.build_unilateral_exit_trees()` → emergency unilateral exit
- `client.unilateral_vtxo_exit_delay_seconds()` → timing info

## Configuration

```rust
pub struct RefreshAgentConfig {
    pub poll_interval: Duration,                // Default: 60s
    pub safety_margin: Duration,                // Default: 3 days
    pub max_vtxo_count: usize,                 // Default: 10
    pub dust_threshold_sats: u64,              // Default: 1000
    pub safe_harbor_address: Option<Address>,
    pub safe_harbor_exit_threshold_blocks: u32, // Default: 432 (72h)
    pub esplora_url: Option<String>,           // Required for block-height networks
}
```

## Events (Discriminated Union)

```rust
pub enum RefreshEvent {
    Check { expiring_count: usize, vtxo_count: usize, dust_count: usize, nearest_expiry_ms: Option<u64>, total_balance_sats: u64 },
    RefreshStart { vtxo_count: usize },
    RefreshOk { txid: Txid },
    RefreshError { error: String },
    ConsolidationStart { vtxo_count: usize, total_sats: u64 },
    ConsolidationOk { txid: Txid, input_count: usize },
    ConsolidationError { error: String },
    ConsolidationSkip { reason: String },
    ReserveLow { actual: u64, required: u64, vtxo_count: usize },
    EmergencyExitTriggered { reason: String },
    EmergencyExitCompleted { txid: Txid, method: ExitMethod },
    EmergencyExitFailed { error: String },
    Stopped,
}
```

## Tick Algorithm

```rust
impl RefreshAgent {
    pub async fn tick(&mut self) -> bool {  // Returns true if error (causes backoff)
        if self.emergency_exit_completed { return false; }

        // 1. Fetch state
        let expiring = wallet.get_expiring_vtxos(safety_margin).await?;
        let all_vtxos = wallet.get_vtxos().await?;
        let spendable = all_vtxos.filter(|v| v.state == Settled || v.state == PreConfirmed);
        let dust_count = spendable.filter(|v| v.value < dust_threshold).count();
        let nearest_expiry = get_nearest_expiry_ms(&spendable, current_block_height);
        let total_balance = spendable.map(|v| v.value).sum();

        // 2. Emit check event
        emit(Check { ... });

        // 3. Reserve check
        check_reserve(spendable.len());

        // 4. Emergency exit check
        if should_emergency_exit(&spendable, block_height) && consecutive_failures > 0 {
            attempt_emergency_exit();
            return false;
        }

        // 5. Renewal
        if !expiring.is_empty() {
            emit(RefreshStart);
            wallet.settle()?;
            consecutive_failures = 0;
            emit(RefreshOk);
            return false;  // Skip consolidation on refresh tick
        }

        // 6. Consolidation (only if no refresh)
        if should_consolidate(&spendable) {
            emit(ConsolidationStart);
            wallet.consolidate(&spendable)?;
            emit(ConsolidationOk);
        }
        return false;
    }
}
```

## Exponential Backoff

- **Growth:** 2x per error
- **Cap:** 10x base interval
- **Reset:** Immediately on success
- **Default max delay:** 60s * 10 = 600s (10 minutes)
- **Storm resilience:** 30 seconds of errors → ~5 ticks fire (not 30)

## Emergency Exit Conditions

All four must be true:
1. `safe_harbor_address` is Some
2. At least one VTXO with valid expiry
3. Expiry within threshold (72h default):
   - Block-height: `blocks_remaining < 432`
   - Timestamp: `remaining_ms < 432 * 10 * 60 * 1000`
4. `consecutive_failures > 0`

## Expiry Module

```rust
/// Is this a block height (not timestamp)?
pub fn is_block_height(batch_expiry: u64) -> bool {
    0 < batch_expiry && batch_expiry < 1_000_000_000
}

/// Normalize to milliseconds (panics on block height input)
pub fn normalize_expiry_ms(batch_expiry: u64) -> u64;

/// Convert block height to remaining ms
pub fn block_height_to_remaining_ms(
    expiry_block: u64,
    current_block: u64,
    avg_block_time_ms: Option<u64>,  // Default: 600_000 (10 min)
) -> Option<u64>;

/// Find nearest VTXO expiry in ms
pub fn get_nearest_expiry_ms(
    vtxos: &[impl HasExpiry],
    current_block_height: Option<u64>,
) -> Option<u64>;
```

**Format discrimination:**
- `0 < value < 1e9` → block height
- `1e9 <= value < 1e12` → Unix seconds (multiply by 1000)
- `value >= 1e12` → Unix milliseconds (use as-is)

## BlockHeightFetcher

```rust
pub struct BlockHeightFetcher {
    esplora_url: String,
    cache: Option<(u64, Instant)>,
    cache_duration: Duration,  // Default: 60s
}

impl BlockHeightFetcher {
    pub async fn get_block_height(&mut self) -> Option<u64>;
    // GET {esplora_url}/blocks/tip/height, 5s timeout
    // Returns cached value on network error
}
```

## Test Specifications (from TS: ~40 tests across 3 files)

### RefreshAgent (30 tests)
| Test | Assert |
|---|---|
| Start/stop clean | State transitions correctly |
| Start idempotent | No duplicate timers |
| Check event has vtxoCount + dustCount | 3 VTXOs (5000, 500, 200) → dust=2 |
| nearestExpiryMs from batchExpiry | 2 VTXOs → nearest ~2 days |
| Seconds conversion | < 1e12 expiry correctly converted |
| Triggers renewal when expiring | Events: check, refresh_start, refresh_ok |
| Error event on renewal failure | refresh_error emitted |
| Error event on check failure | refresh_error emitted |
| Stopped event on stop | stopped emitted |
| Polls on interval | 5s config → correct tick timing |
| Consolidation on count > max | 12 VTXOs → consolidation_start |
| Consolidation on dust | Dust detected → consolidation_start with ALL VTXOs |
| Skip consolidation when not needed | < max, no dust → consolidation_skip |
| Skip consolidation < 2 spendable | 1 VTXO → skip |
| Skip consolidation after refresh | Refresh happened → no consolidation |
| Consolidation error handled | Error emitted, agent continues |
| Only counts settled/preconfirmed | Spent VTXOs excluded |
| Tick returns true on error | Error → true (causes backoff) |
| Backoff doubles | 3 errors → delays 2x, 4x |
| Reset backoff on success | Error then success → back to 1x |
| Caps at 10x | Many errors → max 10x |
| ASP storm resilience | 30s of errors → ~5 ticks |
| Reserve low emitted | 2 VTXOs, 5K reserve → warning |
| No reserve warning when sufficient | Adequate reserve → no warning |
| No exit on first failure | First error → no exit |
| Exit near expiry + failures | 71h expiry, 1 failure → exit triggered |
| Stop after successful exit | Agent stops polling |
| Retry if exit fails | Failed exit → keep running |
| No exit without address | No safe harbor → no exit |
| Reset failures on success | Success resets counter |

### Expiry (10 tests)
| Test | Assert |
|---|---|
| isBlockHeight: typical heights | 800000 → true |
| isBlockHeight: timestamps | 1.7e9 → false |
| normalizeExpiryMs: ms unchanged | >= 1e12 unchanged |
| normalizeExpiryMs: seconds → ms | < 1e12 * 1000 |
| normalizeExpiryMs: block height throws | < 1e9 → error |
| getNearestExpiryMs: empty | → None |
| getNearestExpiryMs: all expired | → None |
| getNearestExpiryMs: mixed formats | Correct nearest |
| blockHeightToRemainingMs: normal | 100 blocks * 600s = 60M ms |
| blockHeightToRemainingMs: expired | → None |
