# Spec 03: Config Module

## Purpose
Centralized configuration: network-specific URLs, thresholds, enforcement flags. All URLs hardcoded per network — no URL construction from components.

## Types

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GolemNetwork {
    Mainnet,
    Mutinynet,
    Regtest,
}

#[derive(Debug, Clone)]
pub struct NetworkConfig {
    pub golem_network: GolemNetwork,
    pub network: String,              // SDK network identifier
    pub network_name: String,         // "bitcoin" | "mutinynet" | "regtest"
    pub ark_server_url: String,
    pub boltz_api_url: String,
    pub mempool_url: String,
    pub encryption_required: bool,
    pub safe_harbor_required: bool,
    pub vtxo_expiry_seconds: u64,
    pub refresh_alert_threshold_seconds: u64,
    pub refresh_warning_threshold_seconds: u64,
    pub address_prefix: String,
    pub valid_address_prefixes: Vec<String>,
}
```

## Network Constants

| Property | Mainnet | Mutinynet | Regtest |
|---|---|---|---|
| `ark_server_url` | `https://arkade.computer` | `https://mutinynet.arkade.sh` | `http://localhost:7070` |
| `boltz_api_url` | `https://api.ark.boltz.exchange` | `https://api.boltz.mutinynet.arkade.sh` | `http://localhost:9069` |
| `mempool_url` | `https://mempool.space/api` | `https://mutinynet.com/api` | `http://localhost:3006/api` |
| `vtxo_expiry_seconds` | 605,184 (7 days) | 172,544 (~2 days) | 3,600 (1 hour) |
| `refresh_alert_threshold_seconds` | 172,800 (48h) | 43,200 (12h) | 900 (15m) |
| `refresh_warning_threshold_seconds` | 259,200 (72h) | 64,800 (18h) | 1,800 (30m) |
| `encryption_required` | true | false | false |
| `safe_harbor_required` | true | false | false |
| `address_prefix` | `bc1` | `tb1` | `bcrt1` |
| `valid_address_prefixes` | `[bc1, 1, 3]` | `[tb1, bcrt1, 2, m, n]` | `[bcrt1, 2, m, n]` |

## Default Constants

```rust
pub const DEFAULT_EXIT_THRESHOLD_BLOCKS: u32 = 432;      // 72 hours at 10 min/block
pub const DEFAULT_ONCHAIN_RESERVE_SATS: u64 = 50_000;
pub const DEFAULT_RESERVE_PER_VTXO: u64 = 15_000;        // tree_depth=6 * bump_tx=250 * fee_rate=10
```

## Functions

```rust
/// Get config from GOLEM_NETWORK env var (default: mutinynet)
pub fn get_network_config(network: Option<&str>) -> Result<NetworkConfig, Error>;

/// Map GolemNetwork to bitcoin address validation network
pub fn to_address_network(network: GolemNetwork) -> bitcoin::Network;
```

## Behavioral Contracts

- `get_network_config(None)` → reads `GOLEM_NETWORK` env var, defaults to `Mutinynet`
- `get_network_config(Some("banana"))` → `Error::UnknownNetwork("banana")`
- Explicit parameter overrides env var
- All networks must have explicit `boltz_api_url` (never derived)

## Test Specifications (from TS: 39 tests across 3 files)

| Test | Assert |
|---|---|
| Mainnet URLs correct | All 3 URLs match constants |
| Mutinynet URLs correct | All 3 URLs match constants |
| Regtest URLs correct | All 3 URLs match constants |
| Unknown network throws | `"banana"` → error |
| Defaults to mutinynet | No env var → mutinynet config |
| GOLEM_NETWORK env respected | `MAINNET` → mainnet config |
| Explicit param overrides env | `get_network_config(Some("mutinynet"))` with `GOLEM_NETWORK=mainnet` → mutinynet |
| Mainnet VTXO expiry 7 days | `vtxo_expiry_seconds == 605184` |
| Mainnet thresholds 48h/72h | Alert: 172800, Warning: 259200 |
| All networks have boltz_api_url | Non-empty for all 3 |
| to_address_network maps correctly | mainnet→mainnet, mutinynet→signet, regtest→regtest |
| Mainnet requires encryption | `encryption_required == true` |
| Mainnet requires safe harbor | `safe_harbor_required == true` |
| Mutinynet no encryption | `encryption_required == false` |
| Mainnet valid prefixes include bc1 | Contains "bc1" |
| Mainnet excludes tb1 | Does NOT contain "tb1" |
| Mutinynet includes tb1 | Contains "tb1" |
| Mutinynet excludes bc1 | Does NOT contain "bc1" |
