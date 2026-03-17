# Rust SDK Compatibility Matrix for Golem Rewrite (v2)

**Date:** 2026-03-17
**Rust SDK Version:** v0.8 (arkade-os/rust-sdk @ HEAD)
**TS SDK Version:** @arkade-os/sdk v0.4.6, @arkade-os/boltz-swap v0.3.3

---

## 1. golem-ark-TS → Rust SDK API Mapping

### Wallet Operations

| golem-ark-TS API Call | TS Module | Rust SDK Equivalent | Rust Module | Status | Notes |
|---|---|---|---|---|---|
| `Wallet.create({ identity, arkServerUrl, esploraUrl, storage })` | `@arkade-os/sdk` | `OfflineClient::new() → .connect()` | `ark-client` | ⚠️ | Rust uses generic `Client<B,W,S,K>` — must provide trait impls for Blockchain, OnchainWallet, BoardingWallet, SwapStorage, KeyProvider |
| `wallet.getAddress()` | `@arkade-os/sdk` | `client.get_offchain_address()` | `ark-client` | ✅ | Returns `(ArkAddress, Vtxo)` tuple |
| `wallet.getBoardingAddress()` | `@arkade-os/sdk` | `client.get_boarding_address()` | `ark-client` | ✅ | |
| `wallet.getBalance()` | `@arkade-os/sdk` | `client.offchain_balance()` | `ark-client` | ⚠️ | Returns `OffChainBalance` with `.pre_confirmed()`, `.confirmed()`, `.recoverable()`, `.total()` — different shape from TS `WalletBalance` |
| `wallet.getVtxos()` | `@arkade-os/sdk` | `client.list_vtxos()` | `ark-client` | ⚠️ | Returns `(VtxoList, HashMap<ScriptBuf, Vtxo>)` — more structured than TS `ExtendedVirtualCoin[]` |
| `wallet.getBoardingUtxos()` | `@arkade-os/sdk` | `client.get_boarding_outputs()` | `ark-client` | ✅ | |
| `wallet.settle(params?, eventCallback?)` | `@arkade-os/sdk` | `client.settle(rng)` / `client.join_next_batch(rng, ...)` | `ark-client` | ⚠️ | No event callback in Rust; requires `Rng + CryptoRng` param |
| `wallet.getTransactionHistory()` | `@arkade-os/sdk` | `client.transaction_history()` | `ark-client` | ✅ | |
| `wallet.sendBitcoin({ address, amount })` | `@arkade-os/sdk` | `client.send_vtxo(address, amount)` | `ark-client` | ✅ | Also has `send_vtxo_selection()` for manual UTXO selection |
| `OnchainWallet.create(identity, network, provider)` | `@arkade-os/sdk` | Implement `OnchainWallet` trait (use `ark-bdk-wallet`) | `ark-bdk-wallet` | ⚠️ | BDK integration crate provided; wiring required |
| `onchainWallet.getBalance()` | `@arkade-os/sdk` | `OnchainWallet::balance()` trait method | `ark-client` | ✅ | Via trait impl |

### VTXO Management & Refresh

| golem-ark-TS API Call | TS Module | Rust SDK Equivalent | Rust Module | Status | Notes |
|---|---|---|---|---|---|
| `VtxoManager(wallet, undefined, { vtxoThreshold })` | `@arkade-os/sdk` | No direct equivalent | — | ❌ | **Golem must build.** Rust SDK has no VtxoManager. Use `list_vtxos()` + custom expiry logic + `settle()` |
| `vtxoManager.getExpiringVtxos(thresholdMs?)` | `@arkade-os/sdk` | No direct equivalent | — | ❌ | Build from `list_vtxos()` + VTXO expiry timestamps. `VtxoList` has `.pre_confirmed()`, `.confirmed()`, `.recoverable()` iterators |
| `vtxoManager.renewVtxos(eventCallback?)` | `@arkade-os/sdk` | `client.settle(rng)` | `ark-client` | ⚠️ | settle() refreshes all VTXOs into a new round; no per-VTXO renewal or event callback |

### Ramps (On/Offboard)

| golem-ark-TS API Call | TS Module | Rust SDK Equivalent | Rust Module | Status | Notes |
|---|---|---|---|---|---|
| `Ramps(wallet).onboard(fees, _, _, eventCallback?)` | `@arkade-os/sdk` | `client.join_next_batch(rng, boarding_inputs, vtxo_inputs, output)` | `ark-client` | ⚠️ | Different API shape — must prepare `BoardingInput` explicitly |
| `Ramps(wallet).offboard(safeHarborAddress, fees, _, eventCallback?)` | `@arkade-os/sdk` | `client.settle(rng)` with on-chain outputs | `ark-client` | 🔍 | Need to verify offboard flow — may require manual PSBT construction |

### Unroll (Emergency Recovery)

| golem-ark-TS API Call | TS Module | Rust SDK Equivalent | Rust Module | Status | Notes |
|---|---|---|---|---|---|
| `Unroll.Session.create({ txid, vout }, onchainWallet, ...)` | `@arkade-os/sdk` | No direct equivalent found | — | 🔍 | Unilateral exit may be handled differently. Investigate `bump_tx()` + manual PSBT |
| `Unroll.completeUnroll(wallet, txids, safeHarborAddress)` | `@arkade-os/sdk` | No direct equivalent found | — | 🔍 | Critical for emergency recovery — needs deeper investigation |

### Identity / Signing

| golem-ark-TS API Call | TS Module | Rust SDK Equivalent | Rust Module | Status | Notes |
|---|---|---|---|---|---|
| `SingleKey.fromRandomBytes()` | `@arkade-os/sdk` | `StaticKeyProvider::new(keypair)` | `ark-client/key_provider` | ✅ | |
| `SingleKey.signerSession()` | `@arkade-os/sdk` | Handled internally by client during settle/send | `ark-client` | ✅ | No manual MuSig2 session management needed at Golem level |
| `Transaction.toPSBT()` / `Transaction.fromPSBT()` | `@arkade-os/sdk` | `bitcoin::Psbt` (standard) | `bitcoin` crate | ✅ | Native PSBT support in Rust |
| GolemIdentity (implements SDK `Identity` interface) | custom | Implement `KeyProvider` trait | `ark-client` | ⚠️ | Different interface shape — see Trait Requirements section |

### Storage / Repositories

| golem-ark-TS API Call | TS Module | Rust SDK Equivalent | Rust Module | Status | Notes |
|---|---|---|---|---|---|
| `SQLiteWalletRepository(executor)` | `@arkade-os/sdk/repositories/sqlite` | No equivalent — Rust SDK doesn't persist wallet state | — | ❌ | **Golem must build.** Wallet state (VTXOs, addresses) tracked server-side in Rust SDK |
| `SQLiteContractRepository(executor)` | `@arkade-os/sdk/repositories/sqlite` | No equivalent | — | ❌ | Same as above — contract state tracked differently |
| `InMemoryWalletRepository()` | `@arkade-os/sdk` | Not needed | — | N/A | Rust SDK manages state internally |
| `SQLiteSwapRepository(executor)` | `@arkade-os/boltz-swap/repositories/sqlite` | `SqliteSwapStorage` (feature: `sqlite`) | `ark-client/swap_storage` | ✅ | SDK provides SQLite impl behind feature flag |

### Boltz / Lightning

| golem-ark-TS API Call | TS Module | Rust SDK Equivalent | Rust Module | Status | Notes |
|---|---|---|---|---|---|
| `BoltzSwapProvider({ apiUrl, network, referralId })` | `@arkade-os/boltz-swap` | Built into `Client` — pass `boltz_url` at construction | `ark-client` | ✅ | No separate provider needed |
| `ArkadeSwaps({ wallet, swapProvider, swapManager, swapRepository })` | `@arkade-os/boltz-swap` | Built into `Client` | `ark-client` | ✅ | Swap operations are direct client methods |
| `arkadeSwaps.startSwapManager()` | `@arkade-os/boltz-swap` | `client.continue_pending_vhtlc_spend_txs()` | `ark-client` | ⚠️ | Manual recovery instead of auto-manager; Golem needs its own recovery loop |
| `arkadeSwaps.createReverseSwap(amount)` | `@arkade-os/boltz-swap` | `client.get_ln_invoice(amount, external_id)` | `ark-client/boltz` | ✅ | |
| `arkadeSwaps.waitAndClaim(swapId, preimage)` | `@arkade-os/boltz-swap` | `client.wait_for_vhtlc(swap_id)` / `client.claim_vhtlc(swap_id, preimage)` | `ark-client/boltz` | ✅ | Two-step in Rust vs combined in TS |
| `arkadeSwaps.createSubmarineSwap(invoice)` | `@arkade-os/boltz-swap` | `client.pay_ln_invoice(invoice)` | `ark-client/boltz` | ✅ | |
| `arkadeSwaps.waitForInvoicePaid(swapId)` | `@arkade-os/boltz-swap` | `client.wait_for_invoice_paid(swap_id)` | `ark-client/boltz` | ✅ | Returns `[u8; 32]` preimage |
| N/A (TS doesn't expose) | — | `client.get_fees()` | `ark-client/boltz` | ✅ | Bonus: fee/limit queries available |
| N/A (TS doesn't expose) | — | `client.get_limits()` | `ark-client/boltz` | ✅ | |
| N/A (TS doesn't expose) | — | `client.refund_vhtlc(swap_id)` | `ark-client/boltz` | ✅ | Collaborative refund |
| N/A (TS doesn't expose) | — | `client.refund_expired_vhtlc(swap_id)` | `ark-client/boltz` | ✅ | Post-timelock refund |

### Covenant

| golem-ark-TS API Call | TS Module | Rust SDK Equivalent | Rust Module | Status | Notes |
|---|---|---|---|---|---|
| `VtxoScript(leafScripts)` | `@arkade-os/sdk` | `Vtxo::new_with_custom_scripts(secp, server_pk, owner_pk, scripts, exit_delay, network)` | `ark-core/vtxo` | ✅ | Supports arbitrary tapscript leaves |
| `MultisigTapscript.encode({ pubkeys })` | `@arkade-os/sdk` | Build with `bitcoin::script::Builder` | `bitcoin` crate | ⚠️ | No direct SDK helper — use raw Script construction |
| `CSVMultisigTapscript.encode({ timelock, pubkeys })` | `@arkade-os/sdk` | Build with `bitcoin::script::Builder` + CSV opcodes | `bitcoin` crate | ⚠️ | Same — must construct manually, but straightforward |
| `RestArkProvider.submitTx(arkTxB64, checkpointTxsB64)` | `@arkade-os/sdk` | `grpc_client.submit_offchain_transaction_request(psbt, checkpoint_txs)` | `ark-grpc` | ⚠️ | gRPC vs REST — different transport but same operation |
| `RestArkProvider.finalizeTx(arkTxid, checkpointTxsB64)` | `@arkade-os/sdk` | `grpc_client.finalize_offchain_transaction(txid, checkpoint_txs)` | `ark-grpc` | ⚠️ | Same — gRPC transport |

### OOR Payment Detection

| golem-ark-TS API Call | TS Module | Rust SDK Equivalent | Rust Module | Status | Notes |
|---|---|---|---|---|---|
| `notifyIncomingFunds()` (via EventSource SSE) | `@arkade-os/sdk` | `client.subscribe_to_scripts(scripts, id)` + `client.get_subscription(id)` → `Stream<SubscriptionResponse>` | `ark-client` / `ark-grpc` | ⚠️ | gRPC streaming vs SSE. Functionally equivalent. Requires tokio async stream consumer. **Better than SSE** — typed, reliable, reconnection handled by tonic |

---

## 2. golem-liquid Pattern Coverage

| golem-liquid Pattern | Description | Rust SDK Coverage | Gap? | Notes |
|---|---|---|---|---|
| **MuSig2 cooperative claim** | Ephemeral per-swap keypair, nonce exchange with Boltz `/v2/swap/reverse/{id}/claim`, partial signature aggregation | `client.claim_vhtlc(swap_id, preimage)` handles internally | ✅ | Rust SDK uses MuSig2 cooperative path (receiver + server) as primary. No script-path fallback. Golem doesn't need to manage MuSig2 sessions manually |
| **Covclaim fallback** | POST to covclaim daemon at `http://127.0.0.1:1234/covenant` for keyless script-path claims | Not in SDK | ❌ Expected | Golem-specific. Port covclaim HTTP client separately (~50 lines). Only needed for Phase 1.5+ |
| **Covenant tx construction** | Tapscript tree with preimage-only spend path, witness = [preimage, script, control_block] | `Vtxo::new_with_custom_scripts()` for address construction. Claiming via covclaim, not SDK | ⚠️ | SDK supports custom VTXO scripts. Claim side is covclaim daemon responsibility |
| **Boltz API — swap creation** | POST `/v2/swap/reverse` with `claimCovenant: true`, ephemeral pubkey | `client.get_ln_invoice()` handles internally | ✅ | SDK manages swap creation and key generation |
| **Boltz API — status monitoring** | WebSocket at `/v2/ws` for real-time swap updates | SDK uses **polling** (`subscribe_to_swap_updates()` with sleep intervals) | ⚠️ | **Latency concern for L402 gateway.** See Critical Gaps §7.1 |
| **Boltz API — cooperative claim endpoint** | POST `/v2/swap/reverse/{id}/claim` with partial sig | Handled internally by `claim_vhtlc()` | ✅ | |
| **Swap store persistence** | JSON file with preimage + ephemeral privkey for crash recovery | `SwapStorage` trait with `SqliteSwapStorage` impl | ✅ | SDK provides structured persistence via trait |
| **Ephemeral per-swap keypair** | Random secp256k1 key per reverse swap, stored for recovery | Managed internally by SDK + `KeyProvider` | ✅ | SDK derives swap keys from KeyProvider |
| **Esplora polling for lockup** | GET `/tx/{txid}/hex`, find vout by script match | `Blockchain::find_outpoints()` + `find_tx()` | ✅ | Via Blockchain trait impl |

---

## 3. Required Trait Implementations

### 3.1 `Blockchain` Trait

```rust
pub trait Blockchain {
    async fn find_outpoints(&self, address: &Address) -> Result<Vec<ExplorerUtxo>, Error>;
    async fn find_tx(&self, txid: &Txid) -> Result<Option<Transaction>, Error>;
    async fn get_tx_status(&self, txid: &Txid) -> Result<TxStatus, Error>;
    async fn get_output_status(&self, txid: &Txid, vout: u32) -> Result<SpendStatus, Error>;
    async fn broadcast(&self, tx: &Transaction) -> Result<(), Error>;
    async fn get_fee_rate(&self) -> Result<f64, Error>;
    async fn broadcast_package(&self, txs: &[&Transaction]) -> Result<(), Error>;
}
```

**TS Equivalent:** Esplora HTTP calls scattered across golem-ark-TS (no unified interface).
**Complexity:** **Moderate.** Straightforward Esplora REST wrapper. ~200 lines. `reqwest` + `serde`.
**Notes:** `broadcast_package` is new — atomic multi-tx broadcast. Check if Esplora supports it or if sequential broadcast is acceptable.

### 3.2 `KeyProvider` Trait

```rust
pub trait KeyProvider: Send + Sync {
    fn get_next_keypair(&self, keypair_index: KeypairIndex) -> Result<Keypair, Error>;
    fn get_keypair_for_path(&self, path: &[u32]) -> Result<Keypair, Error>;
    fn get_keypair_for_pk(&self, pk: &XOnlyPublicKey) -> Result<Keypair, Error>;
    fn get_cached_pks(&self) -> Result<Vec<XOnlyPublicKey>, Error>;
    // Optional (default no-ops):
    fn supports_discovery(&self) -> bool { false }
    fn get_derivation_index_for_pk(&self, pk: &XOnlyPublicKey) -> Option<u32> { None }
    fn derive_at_discovery_index(&self, index: u32) -> Result<Option<Keypair>, Error> { Ok(None) }
    fn cache_discovered_keypair(&self, index: u32, kp: Keypair) -> Result<(), Error> { Ok(()) }
    fn mark_as_used(&self, pk: &XOnlyPublicKey) -> Result<(), Error> { Ok(()) }
}
```

**TS Equivalent:** `GolemIdentity` implements SDK `Identity` interface (sign via PSBT conversion).
**Complexity:** **Moderate.** Maps to GolemSigner hierarchy.
**⚠️ ReadOnlySigner concern:** `get_keypair_for_pk()` returns a full `Keypair` (includes private key). A pubkey-only mode cannot satisfy this trait. **However:** The SDK provides `StaticKeyProvider` (single keypair) and `Bip32KeyProvider` (HD wallet). For Phase 1 (ServerSigner with hot key), `StaticKeyProvider` works directly. ReadOnlySigner mode would require a wrapper that returns errors on signing calls — but the SDK will fail on any operation requiring signing (settle, send, claim). This is acceptable for read-only balance/VTXO queries **only if the SDK doesn't call signing methods during connect/init**.

**Provided implementations:**
- `StaticKeyProvider` — single keypair, maps to ServerSigner/AgentSigner
- `Bip32KeyProvider` — HD wallet with gap-limit discovery

### 3.3 `OnchainWallet` Trait

```rust
pub trait OnchainWallet {
    fn get_onchain_address(&self) -> Result<Address, Error>;
    async fn sync(&self) -> Result<(), Error>;
    fn balance(&self) -> Result<Balance, Error>;
    fn prepare_send_to_address(&self, address: Address, amount: Amount, fee_rate: FeeRate) -> Result<Psbt, Error>;
    fn sign(&self, psbt: &mut Psbt) -> Result<bool, Error>;
    fn select_coins(&self, target_amount: Amount) -> Result<UtxoCoinSelection, Error>;
}
```

**TS Equivalent:** `OnchainWallet.create()` from SDK + Esplora provider.
**Complexity:** **Low.** Use `ark-bdk-wallet` crate — BDK integration provided by SDK. Wraps BDK's `Wallet` with proper Esplora backend.

### 3.4 `BoardingWallet` Trait

```rust
pub trait BoardingWallet {
    fn new_boarding_output(&self, server_pubkey: XOnlyPublicKey, exit_delay: Sequence, network: Network) -> Result<BoardingOutput, Error>;
    fn get_boarding_outputs(&self) -> Result<Vec<BoardingOutput>, Error>;
    fn sign_for_pk(&self, pk: &XOnlyPublicKey, msg: &Message) -> Result<Signature, Error>;
}
```

**TS Equivalent:** Implicit in `Wallet.create()` — SDK handles boarding internally.
**Complexity:** **Low-Moderate.** `ark-bdk-wallet` likely implements this. Verify.

### 3.5 `SwapStorage` Trait

```rust
#[async_trait]
pub trait SwapStorage: Send + Sync {
    async fn insert_submarine(&self, id: String, data: SubmarineSwapData) -> Result<(), Error>;
    async fn insert_reverse(&self, id: String, data: ReverseSwapData) -> Result<(), Error>;
    async fn get_submarine(&self, id: &str) -> Result<Option<SubmarineSwapData>, Error>;
    async fn get_reverse(&self, id: &str) -> Result<Option<ReverseSwapData>, Error>;
    async fn update_status_submarine(&self, id: &str, status: SwapStatus) -> Result<(), Error>;
    async fn update_status_reverse(&self, id: &str, status: SwapStatus) -> Result<(), Error>;
    async fn update_submarine(&self, id: &str, data: SubmarineSwapData) -> Result<(), Error>;
    async fn update_reverse(&self, id: &str, data: ReverseSwapData) -> Result<(), Error>;
    async fn list_all_submarine(&self) -> Result<Vec<SubmarineSwapData>, Error>;
    async fn list_all_reverse(&self) -> Result<Vec<ReverseSwapData>, Error>;
    async fn remove_submarine(&self, id: &str) -> Result<Option<SubmarineSwapData>, Error>;
    async fn remove_reverse(&self, id: &str) -> Result<Option<ReverseSwapData>, Error>;
}
```

**TS Equivalent:** `SQLiteSwapRepository` from `@arkade-os/boltz-swap/repositories/sqlite`.
**Complexity:** **Trivial.** SDK provides `SqliteSwapStorage` behind `sqlite` feature flag. Just enable it.

### Trait Implementation Summary

| Trait | SDK-Provided Impl | Golem Must Build? | Complexity | Blocker? |
|---|---|---|---|---|
| `Blockchain` | None (consumer implements) | **Yes** | Moderate (~200 LOC Esplora wrapper) | No |
| `KeyProvider` | `StaticKeyProvider`, `Bip32KeyProvider` | **No** (use StaticKeyProvider for Phase 1) | Trivial | No |
| `OnchainWallet` | `ark-bdk-wallet` | **No** (use BDK integration) | Low | No |
| `BoardingWallet` | `ark-bdk-wallet` (verify) | **Probably no** | Low | No |
| `SwapStorage` | `SqliteSwapStorage` (feature `sqlite`) | **No** | Trivial | No |

**Go/No-Go:** All traits are satisfiable. No blockers. The only significant implementation work is the `Blockchain` trait (Esplora HTTP wrapper), which is well-understood.

---

## 4. Rust Ecosystem Dependencies

| TS Dependency | Purpose in Golem | Rust Equivalent | Crate | Maturity | Notes |
|---|---|---|---|---|---|
| `hono` + `@hono/node-server` | HTTP server (L402 gateway) | `axum` | `axum` | Production | Best-in-class Rust HTTP. Tower middleware ecosystem |
| `better-sqlite3` | Local storage (wallet, swaps) | `rusqlite` or `sqlx` (SQLite) | `rusqlite` / `sqlx` | Production | SDK uses `sqlx` for SwapStorage. Use `sqlx` for consistency |
| `macaroon` (v3.0.4) | L402 macaroon minting/verification | `macaroon` or hand-roll with `hmac`+`sha2` | `macaroon` / `hmac`+`sha2` | ⚠️ | Rust `macaroon` crate exists but less maintained. Hand-rolling HMAC-SHA256 chain is ~100 LOC and more controllable. Golem already validated JS↔Go binary interop — must validate Rust binary interop too |
| `@noble/hashes` (SHA256) | Macaroon + preimage hashing | `sha2` | `sha2` | Production | RustCrypto standard |
| `@noble/curves` / `@noble/secp256k1` | Key derivation, signing | `secp256k1` (libsecp256k1 FFI) | `secp256k1` | Production | Used by `bitcoin` crate already |
| `@scure/btc-signer` | PSBT construction/signing | `bitcoin` crate (PSBT module) | `bitcoin` | Production | De facto standard |
| `@scure/base` | Base encoding (hex, base64, bech32) | `hex`, `base64`, `bech32` | various | Production | |
| `commander` | CLI argument parsing | `clap` | `clap` | Production | Feature-rich, derive macros |
| `js-yaml` | Config file parsing (golem.yaml) | `serde_yaml` | `serde_yaml` | Production | |
| `dotenv` | .env loading | `dotenvy` | `dotenvy` | Production | Modern fork of `dotenv` |
| `eventsource` (polyfill) | SSE for ASP VTXO notifications | Not needed — SDK uses gRPC streams | — | N/A | **Eliminated.** gRPC streaming replaces SSE |
| Telegram bot (hand-rolled HTTP) | Dashboard bot | `teloxide` or hand-roll with `reqwest` | `teloxide` / `reqwest` | Production | Hand-rolling is ~300 LOC for long-poll + commands. `teloxide` is full-featured but heavy |
| `vitest` | Testing | Built-in (`cargo test`) + `tokio::test` | — | Production | |
| `typescript` / `tsx` | Language tooling | N/A (Rust compiler) | — | N/A | |

### Patterns Without Clean Rust Equivalents

| TS Pattern | Challenge | Rust Approach |
|---|---|---|
| **EventSource/SSE** for ASP notifications | No equivalent needed | SDK uses gRPC streaming (`subscribe_to_scripts`) — **better** |
| **WebSocket** for Boltz swap monitoring | `tokio-tungstenite` exists | SDK uses polling. If latency matters, add WebSocket layer (see §7.1) |
| **Dynamic `import()`** for optional deps | Rust doesn't have runtime module loading | Feature flags at compile time, or `dlopen` (unlikely needed) |
| **Global polyfills** (`Object.assign(globalThis, { EventSource })`) | N/A | Not needed in Rust |

---

## 5. Critical Gaps

### 5.1 Swap Status Monitoring: Polling vs WebSocket

**Issue:** The Rust SDK monitors Boltz swap status via **polling** (`subscribe_to_swap_updates()` loops with configurable sleep intervals). golem-liquid uses **WebSocket** streaming (`/v2/ws`) for real-time payment detection.

**Impact on L402 Gateway:** For the L402 gateway flow:
1. Client sends request → gateway returns 402 + Lightning invoice
2. Client pays invoice → Boltz detects payment → Boltz funds VHTLC
3. **Gateway must detect payment and claim VHTLC to serve the response**

With polling at 1-5 second intervals, step 3 adds 0.5-5 seconds of latency. For API-paying AI agents (Golem's target market), this is likely acceptable — HTTP requests already have multi-second latencies. For interactive human use, it may feel sluggish.

**Recommendation:** Start with SDK polling. If latency becomes a UX issue, implement a thin WebSocket layer on top using `tokio-tungstenite` that calls into the SDK's claim methods. The SDK's `claim_vhtlc()` is independent of the monitoring mechanism.

**Severity:** ⚠️ Low risk. Polling is acceptable for Phase 1.

### 5.2 VtxoManager — No SDK Equivalent

**Issue:** The TS SDK provides `VtxoManager` with `getExpiringVtxos(thresholdMs)` and `renewVtxos(callback)`. The Rust SDK has no equivalent. Golem must build its own refresh scheduling logic.

**Impact:** This is core to Golem's value prop (automated VTXO refresh). The TS `RefreshAgent` depends on VtxoManager.

**What to build:**
```rust
struct RefreshAgent {
    client: Arc<Client<...>>,
    threshold: Duration,
}

impl RefreshAgent {
    async fn check_and_refresh(&self) -> Result<Option<Txid>, Error> {
        let (vtxo_list, _) = self.client.list_vtxos().await?;
        let expiring = vtxo_list.confirmed()
            .filter(|v| v.expiry_time() < now() + self.threshold)
            .collect::<Vec<_>>();
        if !expiring.is_empty() {
            let txid = self.client.settle(&mut rand::thread_rng()).await?;
            Ok(txid)
        } else {
            Ok(None)
        }
    }
}
```

**Complexity:** ~100-200 LOC. Uses existing SDK methods. Not a blocker.

**Severity:** ❌ Must build, but straightforward.

### 5.3 Unroll (Emergency Recovery)

**Issue:** The TS SDK has `Unroll.Session.create()` and `Unroll.completeUnroll()` for unilateral VTXO exit. No clear equivalent found in Rust SDK public API.

**Impact:** Emergency recovery path — used when ASP goes offline and VTXOs must be exited on-chain before expiry. Not needed for normal operation, but critical safety net.

**Investigation needed:** The Rust SDK may handle unilateral exit internally during `settle()` or have it under a different name. The `bump_tx()` method (P2A anchor fee-bumping) suggests some unilateral exit infrastructure exists.

**Severity:** 🔍 Needs deeper investigation. Not a Phase 1 blocker (ASP is available), but must be resolved before production mainnet.

### 5.4 Wallet Repository Persistence

**Issue:** The TS SDK uses `SQLiteWalletRepository` and `SQLiteContractRepository` for local wallet state persistence. The Rust SDK appears to track VTXO state server-side (queried fresh from the Ark server each time).

**Impact:** May affect offline functionality and startup time. If the Rust SDK always queries the server, it's simpler but requires connectivity.

**Severity:** ⚠️ Acceptable for Phase 1 (always-online agent). May need local caching for resilience later.

### 5.5 ReadOnlySigner Compatibility

**Issue:** Golem's `ReadOnlySigner` (pubkey-only, throws on sign) is used for balance/VTXO queries without key material. The Rust SDK's `KeyProvider` trait requires `get_keypair_for_pk()` which returns a full `Keypair`.

**Impact:** Can't create a read-only client that queries balances without providing key material.

**Workaround:** For balance queries, use the gRPC client directly (`list_vtxos` by address) without going through the full `Client<B,W,S,K>`. Or provide a dummy KeyProvider that panics on signing — acceptable if balance queries never trigger signing.

**Severity:** ⚠️ Minor. Affects monitoring/dashboard mode only. Has workarounds.

### 5.6 Macaroon Binary Interop

**Issue:** Golem uses V2 binary-serialized macaroons (validated interop between JS and Go). Rust implementation must produce identical binary output.

**Impact:** If Rust macaroons don't match, the L402 gateway breaks for any client using a different language's macaroon library.

**Action:** Write interop tests early using the existing `test-fixtures/golem-macaroon-interop.json` fixtures.

**Severity:** ⚠️ Must validate, but fixable.

### 5.7 Settlement Event Callbacks

**Issue:** The TS SDK provides `SettlementEvent` callbacks for onboard/settle/renew operations (progress reporting). The Rust SDK's `settle()` and `join_next_batch()` do not appear to have event callbacks.

**Impact:** Golem uses these for Telegram status updates and logging during long operations. Without them, operations are fire-and-forget from the caller's perspective.

**Workaround:** Log at the Golem layer before/after SDK calls. Less granular but acceptable.

**Severity:** ⚠️ Minor UX issue. Not a blocker.

---

## 6. Summary Scorecard

| Category | Total APIs | ✅ Direct | ⚠️ Adaptation | ❌ Must Build | 🔍 Investigate |
|---|---|---|---|---|---|
| Wallet Operations | 11 | 5 | 5 | 0 | 1 |
| VTXO Management | 3 | 0 | 1 | 2 | 0 |
| Ramps | 2 | 0 | 1 | 0 | 1 |
| Unroll | 2 | 0 | 0 | 0 | 2 |
| Identity/Signing | 4 | 3 | 1 | 0 | 0 |
| Storage | 4 | 1 | 0 | 2 | 0 |
| Boltz/Lightning | 8 | 7 | 1 | 0 | 0 |
| Covenant | 5 | 1 | 4 | 0 | 0 |
| OOR Detection | 1 | 0 | 1 | 0 | 0 |
| **Totals** | **40** | **17 (43%)** | **14 (35%)** | **4 (10%)** | **4 (10%)** |

### Must-Build Items (❌)
1. **VtxoManager / RefreshAgent** — ~200 LOC, uses existing SDK methods
2. **Expiring VTXO detection** — part of RefreshAgent, ~50 LOC
3. **SQLiteWalletRepository equivalent** — may not be needed if SDK manages state server-side
4. **SQLiteContractRepository equivalent** — same as above

### Investigation Items (🔍)
1. **Unroll/emergency recovery** — critical safety net, needs SDK source deep-dive
2. **Offboard flow** — verify settle() supports on-chain withdrawal outputs
3. **ark-bdk-wallet BoardingWallet impl** — verify it satisfies the trait
4. **broadcast_package** — verify Esplora supports atomic multi-tx broadcast

---

## 7. Go/No-Go Assessment

### ✅ GO — The Rust rewrite is viable.

**Rationale:**
- **78% of APIs** have direct equivalents or need minor adaptation
- **All required traits** are satisfiable with provided implementations or moderate effort
- **Boltz integration** is more complete in Rust SDK than TS SDK (refund paths, fee queries, limits)
- **OOR detection** is better in Rust (typed gRPC streams vs fragile SSE polyfill)
- **EventSource polyfill nightmare** is eliminated
- **No architectural blockers** — the Rust SDK's generic trait system is more explicit but maps cleanly to Golem's abstractions

**Key risks to track:**
1. Unroll/emergency recovery path — investigate before mainnet
2. Macaroon binary interop — test early with existing fixtures
3. Swap polling latency — monitor, add WebSocket if needed
4. ReadOnlySigner for monitoring mode — may need gRPC-level workaround

**Estimated trait implementation effort:**
- `Blockchain` (Esplora wrapper): ~200 LOC, 1 day
- `KeyProvider`: Use `StaticKeyProvider` — 0 LOC
- `OnchainWallet` + `BoardingWallet`: Use `ark-bdk-wallet` — ~50 LOC wiring
- `SwapStorage`: Use `SqliteSwapStorage` — ~10 LOC feature flag
- **Total trait wiring: ~1-2 days**

**Estimated Golem-specific rebuilds:**
- RefreshAgent: ~200 LOC, 1 day
- L402 gateway (axum): ~500 LOC, 2 days
- Telegram bot: ~300 LOC, 1 day
- CLI (clap): ~200 LOC, 1 day
- Config/storage: ~200 LOC, 1 day
- Macaroon: ~100 LOC, 0.5 day
- Covclaim client: ~50 LOC, 0.5 day
