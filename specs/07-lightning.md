# Spec 07: Lightning Module

## Purpose
Wraps Rust SDK Boltz methods with Golem-specific configuration and startup logic.

## Rust Mapping
In TS, this module creates `BoltzSwapProvider` + `ArkadeSwaps`. In Rust, Boltz operations are **native SDK client methods** — no separate provider needed. Golem adds: config wiring, startup recovery, and the monitoring loop.

## Configuration

```rust
pub struct LightningConfig {
    pub boltz_api_url: String,
    pub network: String,       // "bitcoin" | "mutinynet" | "regtest"
    pub referral_id: String,   // Always "golem"
}

impl LightningConfig {
    pub fn from_network(config: &NetworkConfig) -> Self {
        Self {
            boltz_api_url: config.boltz_api_url.clone(),
            network: config.network.clone(),
            referral_id: "golem".to_string(),
        }
    }
}
```

## SDK Methods Used

| Operation | SDK Method | Notes |
|---|---|---|
| Create Lightning invoice | `client.get_ln_invoice(amount, external_id)` | Returns `ReverseSwapData` with invoice |
| Wait for payment | `client.wait_for_vhtlc(swap_id)` | Blocks until VHTLC funded |
| Claim VHTLC | `client.claim_vhtlc(swap_id, preimage)` | MuSig2 cooperative claim (internal) |
| Pay Lightning invoice | `client.pay_ln_invoice(invoice)` | Creates submarine swap, waits for completion |
| Wait for invoice paid | `client.wait_for_invoice_paid(swap_id)` | Returns preimage `[u8; 32]` |
| Recover pending swaps | `client.continue_pending_vhtlc_spend_txs()` | Startup recovery |
| Get fees | `client.get_fees()` | Boltz fee schedule |
| Get limits | `client.get_limits()` | Min/max swap amounts |
| Refund (collaborative) | `client.refund_vhtlc(swap_id)` | Early refund with Boltz cooperation |
| Refund (expired) | `client.refund_expired_vhtlc(swap_id)` | Post-timelock refund |

## Startup Flow

```rust
pub async fn initialize_lightning(client: &Client<...>) -> Result<(), Error> {
    // Recover any pending swaps from previous session
    client.continue_pending_vhtlc_spend_txs().await?;
    Ok(())
}
```

## Swap Monitoring

The SDK uses **polling** for swap status updates (not WebSocket). For L402 gateway:
- `wait_for_vhtlc()` polls Boltz until VHTLC is funded
- `wait_for_invoice_paid()` polls until invoice is paid
- Polling interval: SDK-internal (~1-5 seconds)
- Acceptable latency for AI agent use case

## Test Specifications (from TS: 7 tests)

| Test | Assert |
|---|---|
| LightningConfig from mutinynet | boltz_api_url correct, network="mutinynet", referral_id="golem" |
| LightningConfig from mainnet | boltz_api_url correct, network="bitcoin" |
| LightningConfig from regtest | boltz_api_url correct, network="regtest" |
| Startup recovery called | `continue_pending_vhtlc_spend_txs` invoked on init |
| SDK methods wired correctly | `get_ln_invoice`, `pay_ln_invoice` delegated properly |
