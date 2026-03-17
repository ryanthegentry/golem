# Spec 13: Telegram Bot

## Purpose
Read-only wallet dashboard and alert delivery via Telegram Bot API. Long-polling (no webhooks). Optional — failure never crashes the server.

## Configuration

```rust
pub struct BotConfig {
    pub bot_token: String,
    pub chat_id: i64,
    pub rate_limit_ms: u64,  // Default: 1000 (1 msg/sec)
}
```

**Environment variables:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Bot Context (Dependency Injection)

```rust
pub struct BotContext {
    pub wallet: Arc<dyn BotWallet>,
    pub get_agent_status: Box<dyn Fn() -> AgentStatus + Send + Sync>,
    pub get_gateway_stats: Option<Box<dyn Fn() -> GatewayStats + Send + Sync>>,
    pub get_event_log: Box<dyn Fn() -> Vec<RefreshEvent> + Send + Sync>,
    pub network_config: NetworkConfig,
}

pub trait BotWallet: Send + Sync {
    async fn get_balance(&self) -> Result<Balance, Error>;
    async fn get_vtxos(&self) -> Result<Vec<Vtxo>, Error>;
    async fn get_transaction_history(&self) -> Result<Vec<Transaction>, Error>;
    async fn get_address(&self) -> Result<String, Error>;
}
```

## Commands

| Command | Handler | Description |
|---|---|---|
| `/status` | `handle_status()` | Balance (total/available/settled), VTXO count, nearest expiry, agent status, network |
| `/txs` | `handle_txs()` | Last 5 transactions (most recent first), "+N more" if truncated |
| `/vtxos` | `handle_vtxos()` | Each VTXO: amount, state, time-to-expiry |
| `/health` | `handle_health()` | Agent running/stopped, VTXO count, balance, last alert time |
| `/gateway` | `handle_gateway()` | Total/paid requests, earnings split (Lightning vs Ark OOR), rate limits |
| `/help`, `/start` | `handle_help()` | Command reference list |

## Notifications (Push)

```rust
impl TelegramBot {
    /// Payment received notification.
    pub async fn notify_payment(&self, rail: &str, sats: u64, hash: &str);

    /// Auto-sweep success.
    pub async fn notify_sweep(&self, amount_sats: u64, destination: &str);

    /// Auto-sweep failure.
    pub async fn notify_sweep_error(&self, error: &str);

    /// Alert timestamp (updated by AlertManager).
    pub fn set_last_alert_time(&self, time: Instant);
}
```

## Polling Architecture

```rust
impl TelegramBot {
    pub async fn start(&mut self);
    pub fn stop(&mut self);

    /// Drain stale updates on startup (offset -1 trick).
    async fn drain_and_poll(&mut self);

    /// Process a single update. Dispatches to command handlers.
    async fn process_update(&self, update: Update);

    /// Rate-limited message send. Silently drops on Telegram API error.
    async fn send_message(&self, chat_id: i64, text: &str, parse_mode: &str);
}
```

**Polling details:**
- Long-poll timeout: 30 seconds
- On startup: Drain stale updates with `offset: -1`, then confirm with `offset: last_id + 1`
- Deduplication: `HashSet<u64>` of processed update IDs (capped at 500)
- Unauthorized chat IDs: Silent ignore (no response)

## Formatter

```rust
/// Escape text for Telegram MarkdownV2.
/// Escapes: _ * [ ] ( ) ~ ` > # + - = | { } . ! \
pub fn escape_markdown_v2(text: &str) -> String;

/// Format wallet status as MarkdownV2.
pub fn format_status(balance: &Balance, vtxos: &[Vtxo], agent: &AgentStatus, network: &str) -> String;

/// Format last 5 transactions. Shows "+N more" if > 5.
pub fn format_txs(txs: &[Transaction]) -> String;

/// Format VTXO list with amounts, states, and time-to-expiry.
pub fn format_vtxos(vtxos: &[Vtxo]) -> String;

/// Format health check.
pub fn format_health(agent: &AgentStatus, vtxos: &[Vtxo], balance: &Balance, last_alert: Option<Instant>) -> String;

/// Format gateway statistics.
pub fn format_gateway(stats: &GatewayStats) -> String;

/// Format help/command list.
pub fn format_help() -> String;

/// Convert milliseconds to human-readable duration ("2d 3h", "45m").
pub fn format_duration(ms: u64) -> String;
```

## Integration Points

- **Gateway mode:** Full context including `get_gateway_stats` callback + payment/sweep notifications
- **Serve mode:** No gateway stats (`get_gateway_stats: None`)
- **Alerts:** `AlertManager` uses bot's `send_message()` for CRITICAL/WARNING/INFO delivery

## Test Specifications (~25 tests across 2 files)

### Bot (14 tests)
| Test | Assert |
|---|---|
| Instantiation | Creates without error |
| Start idempotent | Double start safe |
| Stale update draining | offset -1 on first poll |
| Duplicate deduplication | Same update_id not reprocessed |
| Offset advancement | Next poll uses maxId + 1 |
| Unauthorized chat rejected | Silent ignore for wrong chat_id |
| Payment notification format | Rail, sats, short hash in message |
| Payment notification error tolerance | Telegram failure doesn't crash |
| Alert time storage | set_last_alert_time persists |
| Rate limiting | 1 msg/sec enforced |

### Formatter (11 tests)
| Test | Assert |
|---|---|
| Markdown escaping | All special chars escaped |
| Status formatting | Balance, VTXO count, expiry, agent, network |
| Transaction formatting | Last 5, truncation indicator |
| VTXO list formatting | Amount, state, expiry per VTXO |
| Health check formatting | Agent status, VTXO count, balance, last alert |
| Gateway stats formatting | Lightning/Ark split, totals |
| Help command list | All commands listed |
| Duration formatting | ms → human readable |
