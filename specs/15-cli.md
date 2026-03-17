# Spec 15: CLI

## Purpose
Command-line interface for wallet management, gateway operation, and directory queries. Built with `clap` (Rust equivalent of Commander.js).

## Entry Point

```rust
/// Load ~/.golem/.env before any other initialization.
/// Install global error handlers (clean output, no stack traces to users).
fn main() {
    load_dotenv("~/.golem/.env");
    install_panic_handler();  // Pretty-print, no stack traces
    cli().run();
}
```

## Commands

### `golem init`
Interactive wallet setup.
- Prompts for network (mainnet/mutinynet/regtest)
- Generates keypair (ServerSigner for Phase 1)
- Writes `~/.golem/config.json` (mode 0o600)
- Displays Ark address

### `golem balance`
Display wallet balance.
- Shows total, available (settled), pending
- Formats in sats with comma separators

### `golem pay <destination> [amount]`
Send bitcoin to destination.
- Auto-detects destination type:
  - `lnbc...` → Lightning payment (`pay_ln_invoice`)
  - `bc1...` / `tb1...` → On-chain (`send_bitcoin`)
  - `tark1...` → Ark OOR (`send_oor`)
  - L402 URL → L402 payment flow
- Amount required for on-chain, optional for bolt11 (uses invoice amount)

### `golem receive [amount]`
Generate Lightning invoice for receiving.
- Creates reverse swap via `get_ln_invoice(amount)`
- Displays bolt11 invoice

### `golem gateway`
Start L402 reverse proxy.
- Options: `--upstream`, `--price`, `--port`, `--currency`, `--description`, `--free-paths`, `--no-ark`, `--trusted-proxy`
- Falls back to `golem.yaml` if options not provided
- See spec 14 for full startup sequence

### `golem gateway init`
Interactive gateway setup wizard.
- Auto-discovers local Ollama (`http://localhost:11434`)
- Options: `--force`, `--upstream`, `--price`, `--public-url`, `--service-name`, `--sweep-address`, `--sweep-threshold`
- Validates price (positive number)
- Writes `~/.golem/golem.yaml`
- Initializes default cache settings

### `golem serve`
Start internal L402 API (no upstream proxy).
- Options: `--port` (default 8402), `--host` (default 127.0.0.1)
- Endpoints: `/l402/challenge`, `/l402/verify`, `/l402/status`
- Starts RefreshAgent + Telegram bot

### `golem sweep`
Manual one-off sweep to safe harbor address.
- Uses on-chain `send_bitcoin()` (not Lightning)
- Options: `--keep <sats>` (default 10000), `--dry-run`

### `golem safe-harbor [address]`
Set or display emergency exit address.
- Validates Bitcoin address format and network
- Shows on-chain reserve status

### `golem exit`
Initiate cooperative or unilateral exit.
- Attempts collaborative redeem first
- Falls back to unilateral exit tree

### `golem reserve`
Display on-chain reserve status.

### `golem stats`
Display gateway statistics (if running).

### `golem directory search <query>`
Search 402index.io directory.
- Options: `--category`, `--protocol`, `--max-price`, `--healthy-only`, `--limit`, `--offset`, `--json`
- Client-side sats price filtering
- Formatted table output

### `golem directory list`
List all services in 402index.io.
- Options: `--protocol`, `--healthy-only`, `--category`, `--limit`, `--offset`, `--all`, `--json`
- Pagination display

## Config Management

```rust
pub struct GolemConfig {
    pub version: u32,
    pub network: String,
    pub ark_server: String,
    pub private_key: Option<String>,      // Phase 1 hot key
    pub encrypted_key: Option<String>,    // Future
    pub public_key: Option<String>,
    pub wallet_address: Option<String>,
    pub created_at: String,
    pub safe_harbor_address: Option<String>,
    pub safe_harbor_exit_threshold_blocks: Option<u32>,
    pub onchain_reserve_sats: Option<u64>,
}

/// Load config from ~/.golem/config.json.
/// Backfills defaults for fields added after initial version.
pub fn load_config() -> Result<GolemConfig, Error>;

/// Save config with 0o600 permissions.
pub fn save_config(config: &GolemConfig) -> Result<(), Error>;

/// Override config directory (for testing).
pub fn set_config_dir(path: &Path);
```

## Error Handling

- Global panic handler: Clean single-line error messages, no stack traces
- `EADDRINUSE`: "Port already in use" with suggestion to check for running instances
- Network errors: Retry-friendly messages with suggested actions

## Test Specifications

CLI tests are primarily integration tests run via the binary. Most CLI logic delegates to library functions tested in their respective specs. Gateway config tests (~17 tests) cover YAML load/save, validation, and defaults.
