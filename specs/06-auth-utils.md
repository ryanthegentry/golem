# Spec 06: Auth & Utils

## Auth: Safe Compare

**Purpose:** Constant-time string comparison for API key validation.

```rust
use sha2::{Sha256, Digest};
use subtle::ConstantTimeEq;

pub fn timing_safe_compare(a: &str, b: &str) -> bool {
    let hash_a = Sha256::digest(a.as_bytes());
    let hash_b = Sha256::digest(b.as_bytes());
    hash_a.ct_eq(&hash_b).into()
}

pub fn validate_bearer_token(auth_header: Option<&str>, expected_key: &str) -> bool {
    match auth_header {
        Some(h) if h.starts_with("Bearer ") => timing_safe_compare(&h[7..], expected_key),
        _ => false,
    }
}
```

**Contracts:**
- SHA-256 hashing prevents length leakage
- `subtle::ConstantTimeEq` prevents timing side-channel
- Rejects missing/non-Bearer headers

## Utils: Address Validation

```rust
use bitcoin::Address;

#[derive(Debug)]
pub struct ValidatedAddress {
    pub address: Address,
    pub warnings: Vec<String>,
}

pub fn validate_bitcoin_address(
    address: &str,
    expected_network: bitcoin::Network,
) -> Result<ValidatedAddress, Error>;

pub fn is_bitcoin_address(address: &str, network: bitcoin::Network) -> bool;
```

**Contracts:**
- Reject empty or whitespace-only address
- Detect network from address prefix
- Reject if detected network != expected network → `Error::NetworkMismatch`
- Warn on legacy P2PKH ("higher receive fees")
- Supports: P2PKH, P2SH, P2WPKH, P2WSH, P2TR
- Uses `bitcoin` crate's `Address::from_str()` + `require_network()`

## Test Specifications

### Address Validation (from TS: 17 tests)
| Test | Assert |
|---|---|
| Rejects empty | Error |
| Rejects whitespace | Error |
| Rejects gibberish | Error |
| Rejects Ark addresses | tark1... not a Bitcoin address |
| Validates mainnet P2WPKH | bc1q... passes |
| Validates mainnet P2TR | bc1p... passes |
| Rejects mainnet on mutinynet | Network mismatch |
| Rejects testnet on mainnet | Network mismatch |
| Warns on P2PKH | Warning about fees |
| Trims whitespace | Leading/trailing spaces stripped |
| is_bitcoin_address true for valid | Returns true |
| is_bitcoin_address false for invalid | Returns false |
| is_bitcoin_address false for wrong network | Returns false |
