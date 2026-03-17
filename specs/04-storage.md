# Spec 04: Storage Module

## Purpose
Generic SQLite storage for Golem-specific state (macaroon root keys, gateway config, event log). Wallet VTXO state is NOT stored locally — Rust SDK manages that server-side.

## Rust API

```rust
use sqlx::SqlitePool;

/// Create a SQLite connection pool for Golem-specific state
pub async fn create_pool(db_path: &str) -> Result<SqlitePool, Error> {
    // Create parent directory if needed
    // PRAGMA journal_mode = DELETE (Railway-safe, not WAL)
    // Return pool
}
```

**Note:** The TS `SQLExecutor` interface (`run`, `get`, `all`) wraps `better-sqlite3` sync calls in promises. In Rust, use `sqlx` directly (async-native). The SDK's `SqliteSwapStorage` also uses `sqlx`, so dependencies align.

## What's Stored Locally

| Table | Purpose | Module |
|---|---|---|
| `active_macaroons` | Anti-replay tracker | L402 MacaroonStore |
| `response_cache` | Cache-and-resell | L402 ResponseCache |
| `event_log` | Append-only event log | Server EventLog |
| `golem_config` | Wallet config persistence | CLI Config |

**NOT stored locally:** VTXOs, wallet state, contract state (SDK manages server-side).
**Stored by SDK:** Swap data via `SqliteSwapStorage` (separate database).

## Behavioral Contracts

- `journal_mode = DELETE` (not WAL — Railway persistent volumes don't support WAL reliably)
- Database created at `{data_dir}/golem.db` (Golem-specific state)
- SDK swap database at `{data_dir}/boltz-swaps.db` (SDK manages)
- Parent directory created recursively if missing

## Test Specifications (from TS: 5 tests)

| Test | Assert |
|---|---|
| Execute SQL statements | CREATE TABLE + INSERT works |
| Get returns None for no match | SELECT with false WHERE → None |
| All returns vec of rows | Multiple INSERT → correct vec |
| All returns empty vec for no matches | Empty table → empty vec |
| Handles no params | INSERT DEFAULT VALUES works |
