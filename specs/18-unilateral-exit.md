# Spec 18: Unilateral Exit (Rust SDK Analysis)

## Purpose
Documents the Rust SDK's unilateral exit implementation for Golem's emergency exit path. This is a **Task 1 output** from the Phase 0.5 audit — Golem calls SDK methods, does not reimplement.

## SDK Module: `ark-client/src/unilateral_exit.rs`

The unilateral exit is a multi-step process that broadcasts a VTXO's exit tree progressively, with P2A (Pay-to-Anchor) fee bumping via CPFP.

### Public API

```rust
impl<B, W, S, K> Client<B, W, S, K>
where
    B: Blockchain,
    W: OnchainWallet,
    S: SwapStorage,
    K: KeyProvider,
{
    /// Build the full unilateral exit transaction tree for all VTXOs.
    /// Returns the tree structure needed for progressive broadcast.
    pub async fn build_unilateral_exit_trees(&self) -> Result<Vec<ExitTree>, Error>;

    /// Broadcast the next node in the exit tree.
    /// Uses P2A anchor output for CPFP fee bumping.
    /// Must be called repeatedly as timelocks expire.
    pub async fn broadcast_next_unilateral_exit_node(
        &self,
        exit_tree: &ExitTree,
    ) -> Result<Option<Txid>, Error>;

    /// Send coins on-chain after unilateral exit completes and CSV delay expires.
    pub async fn send_on_chain(
        &self,
        address: &Address,
        amount: u64,
    ) -> Result<Txid, Error>;

    /// Get the delay in seconds before unilateral exit outputs become spendable.
    pub fn unilateral_vtxo_exit_delay_seconds(&self) -> u64;
}
```

### Progressive Broadcast Flow

```
Round Tx (on-chain)
    └── Level 1 node (broadcast immediately)
        └── Level 2 node (broadcast after timelock)
            └── Level 3 node (broadcast after timelock)
                └── VTXO leaf (spendable after CSV delay)
```

1. **Build:** `build_unilateral_exit_trees()` constructs the full tree
2. **Broadcast level-by-level:** `broadcast_next_unilateral_exit_node()` broadcasts one level at a time
3. **Wait for timelock:** Each level has a relative timelock (CSV)
4. **Repeat:** Call `broadcast_next_unilateral_exit_node()` again for next level
5. **Spend:** After final CSV delay, `send_on_chain()` sweeps to destination

### P2A Anchor Fee Bumping

Each intermediate node includes a P2A (Pay-to-Anchor) output:
- Anyone can spend the anchor to attach a CPFP (Child Pays For Parent) transaction
- This allows fee bumping without modifying the pre-signed transaction
- SDK's `OnchainWallet` handles CPFP construction automatically

### Cooperative Alternative

```rust
/// Cooperative exit — requires ASP online. No exit delays.
/// Preferred path when ASP is responsive.
pub async fn collaborative_redeem(
    &self,
    rng: &mut impl CryptoRng,
    address: &Address,
    amount: u64,
) -> Result<Txid, Error>;
```

Located in `ark-client/src/batch.rs`. Always attempted first before unilateral exit.

## Golem Integration (RefreshAgent Emergency Exit)

Golem's RefreshAgent uses the SDK exit methods in a 3-phase sequence:

### Phase 1: Shutdown Gateway
Stop accepting new L402 payments to prevent incoming VTXOs during exit.

### Phase 2: Cooperative Offboard
```rust
// Attempt collaborative_redeem to safe harbor address
let result = client.collaborative_redeem(rng, &safe_harbor_address, total_balance).await;
```

### Phase 3: Unilateral Fallback
```rust
// If cooperative fails, build and broadcast exit tree
let trees = client.build_unilateral_exit_trees().await?;
for tree in &trees {
    loop {
        match client.broadcast_next_unilateral_exit_node(tree).await? {
            Some(txid) => { /* wait for timelock */ },
            None => break,  // Tree fully broadcast
        }
    }
}
// After CSV delay, sweep to safe harbor
client.send_on_chain(&safe_harbor_address, amount).await?;
```

## Emergency Exit Conditions (from spec 10)

All four must be true:
1. `safe_harbor_address` is configured
2. At least one VTXO with valid expiry
3. Expiry within threshold (default 72h / 432 blocks)
4. `consecutive_failures > 0` (at least one refresh failed)

## Timing

- **Exit delay:** `unilateral_vtxo_exit_delay_seconds()` — protocol-defined (e.g., 24h on mainnet)
- **Total time:** Multiple levels × timelock per level + final CSV delay
- **Must complete before:** VTXO absolute expiry (7 days mainnet)

## Key Constraints

- Unilateral exit requires on-chain fees (BDK wallet must have Bitcoin)
- P2A anchor outputs are dust-sized but require CPFP funding
- Progressive broadcast means monitoring is needed over hours/days
- SDK handles all transaction construction and signing internally
- Golem's role: decide WHEN to exit, provide destination address, monitor progress
