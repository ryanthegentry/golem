# Spec 05: Wallet Module

## Purpose
`GolemWallet` wraps the Rust SDK `Client` with Golem-specific concerns: OOR exposure limits, send mutex, safe harbor exit, on-chain reserve management, and receive-only mode detection.

## Rust API

```rust
pub struct GolemWallet {
    client: Arc<Client<EsploraBlockchain, BdkWallet, SqliteSwapStorage, StaticKeyProvider>>,
    signer: GolemSigner,
    oor_limit_fraction: f64,     // Default: 0.10 (10%)
    oor_limit_min_sats: u64,     // Default: 1_000_000 (0.01 BTC)
    send_lock: Mutex<()>,        // Serialize concurrent sends
    onchain_wallet: OnceCell<BdkWallet>,  // Lazy-init for reserve
}

pub struct GolemWalletConfig {
    pub ark_server_url: String,
    pub esplora_url: String,
    pub network: bitcoin::Network,
    pub data_dir: Option<PathBuf>,     // None = in-memory
    pub boltz_url: String,
    pub oor_limit_fraction: f64,
    pub oor_limit_min_sats: u64,
}

pub struct GolemBalance {
    pub total: Amount,
    pub pre_confirmed: Amount,    // Unsettled OOR
    pub confirmed: Amount,
    pub recoverable: Amount,
}

#[derive(Debug, thiserror::Error)]
pub enum WalletError {
    #[error("OOR limit exceeded: requested {requested} sats, limit is {limit} sats")]
    OorLimitExceeded {
        requested: u64,
        limit: u64,
        total_balance: u64,
    },
    #[error("Wallet is in receive-only mode (no private key)")]
    ReceiveOnly,
    #[error("Unilateral exit requires on-chain reserve. Current: {current}, Required: ~{required} for {vtxo_count} VTXOs")]
    InsufficientReserve {
        current: u64,
        required: u64,
        vtxo_count: usize,
    },
    #[error(transparent)]
    Sdk(#[from] ark_client::Error),
}
```

## Public Methods

```rust
impl GolemWallet {
    pub async fn create(signer: GolemSigner, config: GolemWalletConfig) -> Result<Self, WalletError>;
    pub async fn get_address(&self) -> Result<ArkAddress, WalletError>;
    pub async fn get_boarding_address(&self) -> Result<Address, WalletError>;
    pub async fn get_balance(&self) -> Result<GolemBalance, WalletError>;
    pub async fn get_vtxos(&self) -> Result<VtxoList, WalletError>;
    pub async fn get_expiring_vtxos(&self, threshold: Duration) -> Result<Vec<VirtualTxOutPoint>, WalletError>;
    pub async fn send_bitcoin(&self, address: ArkAddress, amount: Amount) -> Result<Txid, WalletError>;
    pub async fn settle(&self) -> Result<Option<Txid>, WalletError>;
    pub async fn get_transaction_history(&self) -> Result<Vec<Transaction>, WalletError>;
    pub async fn exit_to_safe_harbor(&self, addr: Address, gateway: Option<&dyn Shutdown>) -> Result<ExitResult, WalletError>;
    pub async fn get_onchain_reserve_balance(&self) -> Result<Amount, WalletError>;
    pub async fn get_required_reserve(&self) -> Result<ReserveInfo, WalletError>;
    pub fn signer_info(&self) -> SignerInfo;
    pub fn public_key(&self) -> XOnlyPublicKey;
    pub fn dispose(&mut self);
}

pub struct ExitResult {
    pub txid: Txid,
    pub method: ExitMethod,
}

pub enum ExitMethod {
    Offboard,       // Cooperative (ASP online)
    UnilateralExit, // Unilateral (ASP offline)
}
```

## OOR Exposure Limit

**Purpose:** Prevent fragmented drain attacks where multiple small OOR sends cumulatively exceed safe exposure.

**Calculation:**
```
percent_limit = floor(total_balance * oor_limit_fraction)
max_oor = max(percent_limit, oor_limit_min_sats)
if current_oor + amount > max_oor → OorLimitExceeded error
```

**Defaults:** fraction=0.10, min_sats=1,000,000

**Edge cases:**
| Balance | Fraction | Floor | Effective Limit |
|---|---|---|---|
| 20M | 10% | 1M | max(2M, 1M) = 2M |
| 5M | 10% | 1M | max(500K, 1M) = 1M |
| 0 | 10% | 1M | max(0, 1M) = 1M |

**Boundary:** `current_oor + amount > max_oor` is strict; equality passes.

## Send Mutex

**Purpose:** Serialize all `send_bitcoin()` calls to prevent OOR limit bypass via concurrent sends.

```rust
pub async fn send_bitcoin(&self, address: ArkAddress, amount: Amount) -> Result<Txid, WalletError> {
    let _guard = self.send_lock.lock().await;
    self.enforce_oor_limit(amount).await?;
    self.client.send_vtxo(address, amount).await.map_err(WalletError::Sdk)
}
```

## Safe Harbor Exit

**3-phase flow:**
1. **Shutdown gateway** if provided (`gateway.shutdown()`)
2. **Try cooperative:** `client.collaborative_redeem(rng, safe_harbor, full_balance)`
3. **Fallback unilateral:** `client.build_unilateral_exit_trees()` → progressive broadcast → `send_on_chain(safe_harbor, amount)`

**Reserve check before unilateral:** `vtxo_count * DEFAULT_RESERVE_PER_VTXO` sats required.

## Test Specifications (from TS: 26 tests across 7 files)

### Integration (golem-wallet.test.ts, 6 tests)
| Test | Assert |
|---|---|
| Creates wallet, fetches addresses | Ark address has correct prefix |
| Zero balance for fresh wallet | All balance fields == 0 |
| Returns signer info | Type matches |
| Returns 32-byte x-only pubkey | Correct length |
| Same signer → same address | Deterministic |
| No expiring VTXOs for fresh wallet | Empty vec |

### Send Mutex (3 tests)
| Test | Assert |
|---|---|
| Concurrent sends: second rejected when cumulative > cap | First succeeds, second → OorLimitExceeded |
| Sequential sends under cap | Both succeed |
| Serialization verified | Sends execute in order (no interleaving) |

### OOR Limit (8 tests)
| Test | Assert |
|---|---|
| Under limit succeeds | SDK send called |
| Over limit throws | OorLimitExceeded, SDK NOT called |
| Large balance: fraction dominates | 50M balance, 5M sends work, 5M+1 fails |
| Small balance: floor dominates | 5M balance, 1M works, 1M+1 fails |
| Zero balance: floor applies | 0 balance, 500K works, 1M+1 fails |
| Custom config overrides | 5% fraction + 500K floor respected |
| Error metadata correct | requestedSats, limitSats, totalBalance all correct |
| Passes through to SDK on success | SDK called with exact params |

### Pubkey Wallet (3 tests)
| Test | Assert |
|---|---|
| ReadOnly can getAddress | Returns valid address |
| ReadOnly can getBalance | Returns zero balance |
| ReadOnly send throws | Error matches "receive-only" |

### Dispose (3 tests)
| Test | Assert |
|---|---|
| dispose() callable | No panic |
| dispose() calls signer.dispose() | Signer dispose invoked |
| Idempotent | Two calls no panic |

### Safe Harbor (6 tests basic + 5 adversarial)
| Test | Assert |
|---|---|
| Required reserve zero for empty wallet | vtxo_count=0, required=0, per_vtxo=15000 |
| Reserve balance zero for unfunded | 0 sats |
| OnchainWallet created on demand | Address returned |
| OnchainWallet cached | Same instance on second call |
| Cooperative offboard attempted first | ASP info fetched |
| Fallback to unilateral when ASP offline | method=UnilateralExit |
| Insufficient reserve throws | Error contains "on-chain reserve" |
| Gateway shutdown before exit | shutdown() called |
| Network-aware address validation | tb1 on mainnet rejected, bc1 on testnet rejected |
