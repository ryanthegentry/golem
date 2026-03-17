# Spec 14: Server

## Purpose
Long-running HTTP daemon exposing wallet API, refresh agent, SSE event stream, and optional L402 internal API. Two operational modes: full server (port 3000) and gateway reverse proxy (port 8402).

## Server Mode (Full Daemon)

### Endpoints

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| GET | `/health` | None | None | `{ status: "ok", uptime: f64 }` |
| GET | `/api/balance` | API key | None | Wallet balance |
| GET | `/api/address` | API key | None | Ark + boarding addresses |
| GET | `/api/transactions` | API key | None | Transaction history |
| POST | `/api/send` | API key | 10/min | Send bitcoin |
| POST | `/api/receive` | API key | 3/min | Generate Lightning invoice |
| POST | `/api/onboard` | API key | None | Onboard to Ark |
| GET | `/api/agent/status` | API key | None | RefreshAgent status |
| GET | `/api/agent/events` | API key | None | SSE event stream (30s keepalive) |
| GET | `/api/info` | API key | None | Signer type, pubkey, OOR limit |
| * | `/l402/*` | Varies | Varies | L402 internal API (if Lightning available) |

### Authentication

```rust
/// Fail-closed: missing GOLEM_API_KEY → reject all /api/* requests.
/// Uses timing_safe_compare (spec 06).
pub fn auth_middleware(api_key: &str) -> impl Middleware;
```

- No API key configured: Bind to `127.0.0.1` only (local access)
- API key configured: Bind to `0.0.0.0` (remote access enabled)

### SSE Event Stream

```rust
/// GET /api/agent/events — Server-Sent Events for refresh agent.
/// Keepalive comment every 30 seconds.
/// Events serialized as JSON.
pub async fn agent_events_handler(event_log: &EventLog) -> Sse;
```

### POST /api/receive

```rust
pub struct ReceiveRequest {
    pub amount_sats: u64,
}

pub struct ReceiveResponse {
    pub invoice: String,     // bolt11 invoice
    pub swap_id: String,     // For status tracking
    // NOTE: preimage and payment_hash NOT exposed (security)
}
```

### POST /api/send

```rust
pub struct SendRequest {
    pub destination: String,  // Bitcoin address or Lightning invoice
    pub amount_sats: Option<u64>,  // Required for on-chain, optional for bolt11
}
```

## Gateway Mode (L402 Reverse Proxy)

See spec 08 for L402 gateway details. Gateway mode adds:

### Configuration (golem.yaml)

```rust
pub struct GatewayConfig {
    pub upstream: String,              // Required
    pub price: u64,                    // Required, sats
    pub description: Option<String>,
    pub port: u16,                     // Default: 8402
    pub free_paths: Vec<String>,
    pub public_url: Option<String>,
    pub service_name: Option<String>,
    pub registry_url: Option<String>,
    pub category: Option<String>,
    pub contact_email: Option<String>,
    pub probe_body: Option<String>,
    pub auto_register: bool,           // Default: true
    pub cache_enabled: bool,
    pub cache_default_ttl: u64,        // Default: 3600
    pub cache_price_percent: u32,      // Default: 20
    pub cache_max_size: usize,         // Default: 10_000
    pub sweep: Option<SweepConfig>,
}
```

**Persisted as:** `~/.golem/golem.yaml` with `gateway:` root key. File mode `0o600`.

### Gateway Startup Sequence

1. Install process guard
2. Load wallet + signer
3. Start RefreshAgent (with emergency exit handle)
4. Create L402 gateway (Lightning + Ark OOR if address available)
5. Wire gateway shutdown into emergency exit handle
6. Start Telegram bot (if configured)
7. Start AutoSweep (if configured)
8. Fire-and-forget 402index registration
9. Start HTTP server

### Free Endpoints (Gateway)

- `/health` — public health check
- `/l402/preimage` — Ark OOR preimage polling
- `/stats` — protected (requires `GOLEM_API_KEY`)

### Self-Proxy Detection

Gateway validates upstream URL to prevent infinite loops (upstream != own URL).

## Event Log

```rust
pub struct EventLog {
    events: VecDeque<RefreshEvent>,
    max_capacity: usize,  // Default: 100
}

impl EventLog {
    pub fn push(&mut self, event: RefreshEvent);
    pub fn get_all(&self) -> Vec<RefreshEvent>;  // Returns clone
    pub fn get_last(&self) -> Option<RefreshEvent>;
}
```

**FIFO eviction** when at max capacity. Returns clones (immutable from caller's perspective).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Server port |
| `GOLEM_API_KEY` | None | API authentication key |
| `GOLEM_HOST` | `127.0.0.1` / `0.0.0.0` | Bind host (auto-selected based on API key) |
| `GOLEM_L402_DATA_DIR` | `./data-l402` | L402 SQLite store directory |
| `GOLEM_TRUSTED_PROXY` | None | Trust x-forwarded-for headers |
| `TELEGRAM_BOT_TOKEN` | None | Optional Telegram bot |
| `TELEGRAM_CHAT_ID` | None | Optional Telegram chat |

## Config Files

| Path | Format | Mode | Content |
|---|---|---|---|
| `~/.golem/config.json` | JSON | 0o600 | Wallet config (network, keys, addresses) |
| `~/.golem/golem.yaml` | YAML | 0o600 | Gateway config |
| `~/.golem/.env` | dotenv | — | Environment overrides |

## Test Specifications (~20 tests)

### Event Log (5 tests)
| Test | Assert |
|---|---|
| Push and retrieve | Events stored in order |
| FIFO eviction | Oldest removed at capacity |
| get_last returns latest | Most recent event |
| get_all returns clone | Immutable from caller |
| Empty log | Returns empty vec / None |

### POST /api/receive (15 tests)
| Test | Assert |
|---|---|
| Valid request | Returns invoice + swap_id |
| Auth required | 401 without API key |
| Rate limited | 429 after 3 requests/min |
| Invalid amount | 400 on zero/negative |
| Preimage not leaked | Response excludes preimage and paymentHash |
| Lightning unavailable | 503 error |
