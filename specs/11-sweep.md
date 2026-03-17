# Spec 11: Auto-Sweep

## Purpose
Automated excess balance sweep to Lightning destinations. Monitors wallet balance on a polling interval and sweeps amounts above a configurable threshold, keeping operational liquidity. Supports Lightning Address, LNURL-pay, and bolt11 invoice formats.

## Configuration

```rust
pub struct SweepConfig {
    pub enabled: bool,
    pub address: String,              // Lightning Address, LNURL-pay, bolt11
    pub threshold: u64,               // Sweep when balance > threshold sats
    pub keep: u64,                    // Default: 10_000 sats
    pub min_sweep: u64,               // Default: 5_000 sats
    pub poll_interval: Duration,      // Default: 60s
    pub cooldown: Duration,           // Default: 10 minutes
    pub max_consecutive_failures: u32, // Default: 3
    pub circuit_breaker_duration: Duration, // Default: 1 hour
}
```

## Address Types

```rust
pub enum SweepAddressType {
    LightningAddress,  // user@domain → LNURL-pay resolution
    LnurlPay,          // bech32-encoded lnurl1...
    LnurlRaw,          // Raw HTTPS URL
    Bolt11,            // Lightning invoice (single-use)
}

pub fn detect_address_type(address: &str) -> Result<SweepAddressType, Error>;
```

## Address Resolver

```rust
pub struct ResolvedInvoice {
    pub bolt11: String,
    pub amount_sats: u64,
}

pub struct LnurlPayResponse {
    pub callback: String,
    pub min_sendable: u64,  // millisats
    pub max_sendable: u64,  // millisats
    pub tag: String,        // "payRequest"
}

/// Resolve any supported address type to a payable bolt11 invoice.
/// Total timeout: 20s. Individual request timeout: 15s.
pub async fn resolve_address(
    address: &str,
    amount_sats: u64,
) -> Result<ResolvedInvoice, Error>;
```

**Resolution flow:**
1. Lightning Address: `user@domain` → `GET https://domain/.well-known/lnurlp/user` → LNURL-pay flow
2. LNURL-pay (bech32): Decode → HTTPS URL → LNURL-pay flow
3. LNURL-pay flow: GET metadata → clamp amount to `maxSendable` → validate `minSendable` → GET callback with amount → bolt11
4. Bolt11: Pass through (amount already encoded)

**SSRF Prevention:**
- Reject callback URLs pointing to private IPs: `127.x`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`, `0.x`
- Allow HTTP only for `.onion` domains (Tor)
- Require HTTPS for all clearnet callbacks

## Events

```rust
pub enum SweepEvent {
    Check { balance_sats: u64, threshold: u64, sweep_amount: u64 },
    SweepStart { amount_sats: u64, destination: String },
    SweepOk { amount_sats: u64, destination: String },
    SweepSkip { reason: String },
    SweepError { error: String },
    Stopped,
}
```

## Tick Algorithm

```rust
impl AutoSweep {
    pub async fn tick(&mut self) -> bool {
        // 1. Circuit breaker check
        if self.circuit_breaker_active() { emit(SweepSkip); return false; }

        // 2. Cooldown check (10 min after last successful sweep)
        if self.in_cooldown() { return false; }

        // 3. Fetch balance
        let balance = wallet.get_balance().await?;
        let sweep_amount = balance.saturating_sub(config.keep);

        // 4. Threshold check
        if balance <= config.threshold || sweep_amount < config.min_sweep {
            return false;
        }
        emit(Check { ... });

        // 5. Resolve address to bolt11
        let invoice = resolve_address(&config.address, sweep_amount).await?;
        // Clamp to LNURL maxSendable if needed

        // 6. Bolt11 consumed check (single-use detection)
        if self.used_bolt11s.contains(&invoice.bolt11) {
            emit(SweepSkip { reason: "bolt11 already consumed" });
            self.permanently_disabled = true;
            return false;
        }

        // 7. Race condition guard: re-check balance
        let recheck = wallet.get_balance().await?;
        if recheck < invoice.amount_sats { return false; }

        // 8. Execute sweep via wallet.pay_ln_invoice()
        emit(SweepStart { ... });
        wallet.pay_ln_invoice(&invoice.bolt11).await?;

        // 9. Track consumed bolt11, reset failures, set cooldown
        self.used_bolt11s.insert(invoice.bolt11);
        self.consecutive_failures = 0;
        self.last_sweep_at = now;
        emit(SweepOk { ... });
        return false;
    }
}
```

**Note:** Bypasses GolemWallet's OOR limit because Boltz sweeps settle atomically (no unsettled OOR exposure).

## Circuit Breaker

- **Trigger:** 3 consecutive failures
- **Duration:** 1 hour (`6 × cooldown`)
- **Reset:** On next successful sweep
- **During open:** Emits `SweepSkip` with reason, does not attempt sweep

## Graceful Shutdown

```rust
/// Stop sweep agent, waiting up to `timeout` for in-progress sweep.
pub async fn stop_graceful(&mut self, timeout: Duration);
```

- Signals stop via cancellation token
- Waits up to `timeout` (default 25s) for in-progress sweep to complete
- Returns immediately if no sweep in progress

## Test Specifications (~50 tests across 2 files)

### AutoSweep (35+ tests)
| Test | Assert |
|---|---|
| Start/stop lifecycle | Clean start and stop |
| Start idempotent | No duplicate timers |
| Polling interval correct | Ticks at configured interval |
| Sweeps above threshold | balance > threshold + min_sweep → sweep |
| No sweep below threshold | balance < threshold → no sweep |
| Boundary: exactly at threshold | No sweep (must exceed) |
| Keep amount respected | sweep_amount = balance - keep |
| Min sweep enforced | sweep_amount < min_sweep → skip |
| Cooldown after success | 10 min wait between sweeps |
| LNURL maxSendable clamping | Amount clamped to max |
| LNURL minSendable validation | Below min → error |
| Race condition guard | Balance drops between resolve and execute → skip |
| Bolt11 consumed tracking | Same invoice not paid twice |
| Bolt11 single-use permanent disable | Static bolt11 consumed → agent stops |
| Circuit breaker: 3 failures | Activates after 3 consecutive errors |
| Circuit breaker: blocks sweeps | Skip during circuit breaker period |
| Circuit breaker: reset on success | Success clears consecutive failures |
| Graceful shutdown: in-progress | Waits for sweep to complete |
| Graceful shutdown: timeout | Force stop after timeout |
| Events emitted correctly | All event types |
| Config validation | Invalid configs rejected |

### Address Resolver (15+ tests)
| Test | Assert |
|---|---|
| Detect Lightning Address | user@domain → LightningAddress |
| Detect bolt11 | lnbc... → Bolt11 |
| Detect bech32 LNURL | lnurl1... → LnurlPay |
| Detect raw LNURL | https://... → LnurlRaw |
| SSRF: reject private IPs | 127.x, 10.x, 172.x, 192.168.x → error |
| SSRF: allow .onion | HTTP ok for Tor |
| SSRF: require HTTPS clearnet | HTTP rejected for non-.onion |
| Timeout handling | Slow server → timeout error |
| LNURL bounds clamping | Amount clamped to maxSendable |
| LNURL minSendable validation | Below minimum → error |
