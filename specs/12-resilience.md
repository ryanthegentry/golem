# Spec 12: Resilience

## Purpose
Cross-cutting resilience patterns for long-running daemons. Prevents transient network errors from killing the process while still failing fast on fatal errors. Consolidates: process guard, exponential backoff, circuit breakers, graceful shutdown, and rate limiting.

## Process Guard

```rust
pub struct ProcessGuardStats {
    pub transient_errors_caught: u64,
    pub fatal_errors_caught: u64,
    pub last_transient_error: Option<String>,
    pub last_transient_error_at: Option<Instant>,
}

pub struct ProcessGuard {
    stats: ProcessGuardStats,
}

impl ProcessGuard {
    /// Install global panic hook + signal handlers.
    /// Transient errors are logged and suppressed.
    /// Fatal errors trigger process::exit(1).
    pub fn install() -> Self;

    pub fn stats(&self) -> &ProcessGuardStats;

    /// Remove installed handlers.
    pub fn dispose(self);
}
```

**Transient error patterns** (case-insensitive substring match):
- `Too Many Requests`, `EventSource`, `ECONNRESET`, `ECONNREFUSED`
- `ETIMEDOUT`, `EPIPE`, `fetch failed`, `socket hang up`
- `network timeout`, `Bad Gateway`, `Service Unavailable`
- `getaddrinfo`, `EHOSTUNREACH`

**Fatal errors:** Anything not matching transient patterns → `process::exit(1)`.

**In Rust:** Implement via `std::panic::set_hook()` for panics. For async errors, each subsystem handles its own error classification. The ProcessGuard pattern applies primarily to top-level unhandled errors.

## Exponential Backoff (RefreshAgent pattern)

```rust
pub struct BackoffConfig {
    pub base_interval: Duration,     // Default: 60s
    pub growth_factor: u32,          // Default: 2
    pub max_multiplier: u32,         // Default: 10
}

// Usage in polling loops:
// on_error:  multiplier = min(multiplier * growth, max_multiplier)
// on_success: multiplier = 1
// delay = base_interval * multiplier
```

**Storm resilience:** With 60s base and 10x cap, 30 seconds of errors produces ~5 ticks (not 30).

## Circuit Breaker (3 variants)

### 1. Boltz Invoice Circuit Breaker (L402 Gateway)
- **Window:** 60 seconds sliding
- **Threshold:** 5 failures
- **Open duration:** 30 seconds
- **Behavior when open:** Return HTTP 503 with `Retry-After: 30`
- **Reset:** On successful invoice creation
- **Retry before recording failure:** 3 attempts with backoff (500ms, 1s, 2s)

### 2. Auto-Sweep Circuit Breaker
- **Threshold:** 3 consecutive failures
- **Open duration:** 1 hour
- **Reset:** On successful sweep
- **No sliding window:** Consecutive count only

### 3. VTXO Listener Reconnect Backoff
- **Sequence:** 5s, 10s, 20s, 40s, 60s (ceiling)
- **Reset:** On successful reconnect
- **Behavior:** Exponential with 60s ceiling, retries indefinitely

## Rate Limiting

### HTTP Rate Limiter (Server API)
| Endpoint | Limit |
|---|---|
| `POST /api/send` | 10/min |
| `POST /api/receive` | 3/min |

### Gateway Rate Limiter
- **Per-IP sliding window:** 30 requests/min/IP (60s window)
- **Exempt paths:** `/l402/preimage`
- **Proxy trust:** Only trust `x-forwarded-for` if `GOLEM_TRUSTED_PROXY` set

### Invoice Limiter (L402)
- **Max pending unpaid:** 10
- **Stale timeout:** 15 minutes
- **At limit behavior:** Return oldest pending invoice (reuse)

### Telegram Bot
- **Rate limit:** 1 message/second (configurable via `rate_limit_ms`)

## Graceful Shutdown

**Signal handling:** `SIGTERM` and `SIGINT`.

**Gateway shutdown sequence:**
1. Stop accepting new connections
2. Wait up to 25s for in-progress auto-sweep
3. Stop Telegram bot
4. Stop RefreshAgent
5. Flush and close SQLite stores
6. Zeroize signer key material
7. `process::exit(0)`

**Server shutdown sequence:**
1. Log shutdown
2. Zeroize signer key material
3. Clear cleanup intervals
4. `process::exit(0)`

**Railway note:** Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` for Railway deployments.

## Test Specifications (~20 tests)

### Process Guard (9 tests)
| Test | Assert |
|---|---|
| Transient EventSource suppressed | Not fatal |
| Transient 429 suppressed | Not fatal |
| Transient ECONNRESET suppressed | Not fatal |
| Transient fetch failed suppressed | Not fatal |
| Transient Bad Gateway suppressed | Not fatal |
| Fatal error exits | exit(1) called |
| Stats tracking | Counters increment |
| Dispose cleanup | Handlers removed |
| Storm resilience | 50 waves × 3 errors → all suppressed |

### Backoff (tested via RefreshAgent — see spec 10)

### Circuit Breaker (tested via L402 and AutoSweep — see specs 08, 11)
