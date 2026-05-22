# Spec 19: ReadOnlySigner Architecture Decision

## Purpose
Documents the **Task 2 output** from Phase 0.5 — why ReadOnlySigner is incompatible with the Rust SDK and the decision to defer it.

## The Problem

In the TS implementation, `GolemIdentity` has a `ReadOnlyIdentity` variant that holds only the public key. This enables:
- Balance checking without private key access
- VTXO monitoring without signing capability
- "Watch-only" wallet mode

## SDK Constraint

The Rust SDK's `KeyProvider` trait requires:

```rust
pub trait KeyProvider: Send + Sync {
    fn get_keypair(&self) -> Keypair;  // Keypair includes private key
}
```

`Keypair` is `secp256k1::Keypair` which **always contains both private and public keys**. There is no way to satisfy `KeyProvider` with only a public key.

The SDK's `Client<B, W, S, K>` is generic over `K: KeyProvider`, meaning every `Client` instance must have signing capability.

## Options Evaluated

### Option A: Dummy Private Key
Create a `ReadOnlyKeyProvider` that returns a dummy/zero private key.
- **Rejected:** Any accidental signing would produce invalid transactions. Silent data corruption risk.

### Option B: Separate Read-Only Client
Build a separate client type that doesn't require `KeyProvider`.
- **Rejected:** Would require forking or wrapping large parts of the SDK. Maintenance burden.

### Option C: Upstream SDK Change
Propose splitting `KeyProvider` into `PublicKeyProvider` + `SigningKeyProvider`.
- **Deferred:** Requires SDK team coordination. Not blocking Phase 1.

### Option D: Use StaticKeyProvider (Phase 1)
Use the SDK's built-in `StaticKeyProvider` which holds a full keypair.
- **Selected:** Same security model as every Lightning node. Acceptable for testnet and small mainnet amounts.

## Decision

**Defer ReadOnlySigner to post-Phase 1.** Use `StaticKeyProvider` (hot key encrypted on disk) for Phase 1.

**Rationale:**
1. Phase 1 target is testnet + small mainnet amounts
2. `StaticKeyProvider` matches the security model of hot-key wallets and LN nodes
3. ReadOnlySigner adds complexity with no Phase 1 benefit
4. Covenant-based keyless receive (Phase 1.5) is the real security upgrade
5. Hardware signer integration (Tapsigner) is the Phase 2+ path for large amounts

## Future Path

When ReadOnlySigner becomes needed:
1. **Phase 1.5:** Covenant claim daemon eliminates need for signing key in receive path
2. **Phase 2:** MobileSigner (phone) or HardwareSigner (Tapsigner) for outbound signing
3. **SDK evolution:** If `KeyProvider` is split, ReadOnlyClient becomes trivial

## Impact on Golem Architecture

- `GolemSigner` interface remains as documented in spec 01
- Phase 1 implementation: `GolemSigner::from_keypair()` wrapping `StaticKeyProvider`
- Key stored encrypted on disk (Phase 1 pragmatic security)
- `dispose()` method zeroizes key material on shutdown
- No watch-only mode in Phase 1
