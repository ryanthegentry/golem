# Spec 17: Monitoring & Alerts

## Purpose
Telegram-based alerting with cooldown deduplication. Monitors VTXO expiry, balance thresholds, refresh failures, and emergency exits.

## Alert Configuration

```rust
pub struct AlertConfig {
    pub bot_token: String,
    pub chat_id: i64,
}

/// Load from TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars.
/// Returns None if either is missing.
pub fn load_alert_config() -> Option<AlertConfig>;
```

## Alert Manager

```rust
pub enum AlertLevel {
    Info,
    Warning,
    Critical,
}

pub struct AlertManager {
    config: AlertConfig,
    cooldowns: HashMap<String, Instant>,
    default_cooldown: Duration,  // Default: 1 hour
}

impl AlertManager {
    /// Send alert to Telegram. Never throws on delivery failure.
    /// Respects cooldown per condition key.
    pub async fn send_alert(&mut self, condition: &str, message: &str, level: AlertLevel);

    /// Check VTXO expiry and emit alerts.
    /// CRITICAL: nearest expiry < 48 hours
    /// WARNING: nearest expiry < 72 hours
    pub async fn check_vtxo_expiry(
        &mut self,
        nearest_expiry_ms: Option<u64>,
        alert_threshold_ms: u64,    // Default: 48h
        warning_threshold_ms: u64,  // Default: 72h
    );

    /// Check balance thresholds.
    /// WARNING: balance > 200,000 sats (high)
    /// WARNING: balance < 5,000 sats (low)
    pub async fn check_balance(&mut self, sats: u64);

    /// Clear alert cooldown for a condition (e.g., on successful refresh).
    pub fn clear(&mut self, condition: &str);
}
```

## Alert Conditions (Wired in RefreshAgent Setup)

| Condition Key | Trigger | Level | Cooldown |
|---|---|---|---|
| `refresh_error` | RefreshAgent tick error | WARNING | 1 hour |
| `emergency_exit` | Emergency exit triggered | CRITICAL | 1 hour |
| `emergency_exit_failed` | Emergency exit failed | CRITICAL | 1 hour |
| `reserve_low` | On-chain reserve insufficient | WARNING | 1 hour |
| `vtxo_expiry` | VTXO approaching expiry | CRITICAL/WARNING | 1 hour |
| `balance_high` | Balance > 200k sats | WARNING | 1 hour |
| `balance_low` | Balance < 5k sats | WARNING | 1 hour |

## Telegram Delivery

```rust
/// Send message via Telegram Bot API.
/// POST https://api.telegram.org/bot{token}/sendMessage
/// Parse mode: MarkdownV2
/// Timeout: 15 minutes + 10s jitter (long-poll context)
/// Never throws — logs error and continues.
async fn send_telegram(config: &AlertConfig, message: &str) -> bool;
```

## Integration

AlertManager is created in `refresh_setup()` and shared between:
- RefreshAgent event handler (refresh errors, emergency exit, reserve low)
- Periodic checks (VTXO expiry, balance thresholds)
- Telegram bot (`set_last_alert_time` for `/health` display)

## Test Specifications (14 tests)

| Test | Assert |
|---|---|
| Alert sent to Telegram | POST to bot API with message |
| Telegram failure doesn't throw | Returns false, logs error |
| Cooldown prevents duplicate | Same condition within cooldown → no send |
| Cooldown expires | After cooldown → send again |
| Clear resets cooldown | `clear("refresh_error")` → next alert sends |
| VTXO expiry CRITICAL | < 48h → CRITICAL alert |
| VTXO expiry WARNING | < 72h → WARNING alert |
| VTXO expiry OK | > 72h → no alert |
| Balance high WARNING | > 200k → WARNING |
| Balance low WARNING | < 5k → WARNING |
| Balance normal | 5k-200k → no alert |
| Alert level in message | Level prefix in text |
| Multiple conditions independent | Different keys have separate cooldowns |
| Config loading | Missing env vars → None |
