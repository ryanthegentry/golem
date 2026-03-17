# Spec 01: Signer Module

## Purpose
All signing in Golem flows through the `GolemSigner` trait. Phase 1 uses `StaticKeyProvider` (SDK-provided hot key). ReadOnlySigner deferred to post-Phase 1 (see spec 19).

## Rust Mapping
- `GolemSigner` interface → `KeyProvider` trait (SDK)
- `MockSigner` → `StaticKeyProvider` (SDK-provided)
- `ServerSigner` → `StaticKeyProvider` with encrypted-at-rest persistence (Golem builds)
- `ReadOnlySigner` → Deferred (see spec 19)
- `GolemIdentity` → Absorbed by SDK (KeyProvider handles signing internally)

## Phase 1 API

```rust
/// Golem's signer abstraction (wraps SDK KeyProvider for Golem-specific concerns)
pub struct GolemSigner {
    key_provider: Arc<dyn KeyProvider>,
    signer_type: SignerType,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SignerType {
    Mock,
    Server,
    ReadOnly, // Phase 2
}

pub struct SignerInfo {
    pub signer_type: SignerType,
    pub label: String,
    pub supports_delegation: bool,
}

pub struct SignerStatus {
    pub available: bool,
    pub last_seen: String, // ISO 8601
}

impl GolemSigner {
    /// Create from raw keypair (Phase 1: hot key)
    pub fn from_keypair(kp: Keypair) -> Self;

    /// Create from hex-encoded secret key
    pub fn from_secret_key_hex(hex: &str) -> Result<Self, Error>;

    pub fn info(&self) -> SignerInfo;
    pub fn public_key(&self) -> XOnlyPublicKey;
    pub fn key_provider(&self) -> Arc<dyn KeyProvider>;
    pub fn ping(&self) -> SignerStatus;

    /// Zero key material (best-effort via Zeroize trait)
    pub fn dispose(&mut self);
}
```

## Behavioral Contracts

### Construction
- `from_secret_key_hex(hex)`: hex must be exactly 64 chars, valid secp256k1 scalar
- Invalid hex → `Error::InvalidSecretKey`
- All-zeros key → `Error::InvalidSecretKey`

### Signing
- All signing delegated to SDK via `KeyProvider` trait
- No PSBT round-trip needed (Rust SDK handles signing internally)
- No manual MuSig2 session management

### Disposal
- `dispose()` zeros key material via `zeroize` crate
- After dispose, all operations return `Error::SignerDisposed`
- Idempotent (safe to call multiple times)

### Security
- Private key never in logs, error messages, or return values
- `Debug` impl must NOT include key material
- `Display` impl shows only public key prefix

## Signer Resolution

```rust
pub fn resolve_signer(config: &GolemConfig) -> Result<GolemSigner, Error> {
    // Priority order:
    // 1. GOLEM_SIGNER_KEY env var (plaintext hex)
    // 2. Config file encrypted key (requires GOLEM_PASSWORD)
    // 3. Config file plaintext key
    // 4. Config file pubkey only → Error (Phase 1 requires signing)
}
```

## Test Specifications (from TS: 35 tests across 6 files)

### MockSigner equivalent (StaticKeyProvider)
| Test | Assert |
|---|---|
| Creates valid instance | Public key is 32-byte x-only |
| Deterministic from same secret | Same input → same public key |
| Rejects invalid key | All zeros → error |
| Two signers differ | Random signers have different pubkeys |
| Ping reports available | `status.available == true` |
| Info returns correct type | `info.signer_type == SignerType::Mock` |

### Disposal
| Test | Assert |
|---|---|
| Zeros key material | After dispose, operations fail |
| Descriptive error | Error message contains "disposed" |
| Idempotent | Two dispose calls don't panic |

### ServerSigner equivalent
| Test | Assert |
|---|---|
| from_secret_key_hex creates working signer | Valid pubkey returned |
| Info reports server type | `signer_type == SignerType::Server` |

### Security
| Test | Assert |
|---|---|
| No key material in Debug output | `format!("{:?}", signer)` doesn't contain hex key |
| No key material in error messages | Error strings don't contain hex key |

### Key Crypto (OUT OF SCOPE for Phase 1)
Skip: `encryptSecretKeySync`, `decryptSecretKeySync`, `encryptSecretKeyAsync`, `decryptSecretKeyAsync`, `isEncryptedKeyData`, password validation tests, scrypt params tests.
**Reason:** Phase 1 uses plaintext key or env var. Encryption deferred.
