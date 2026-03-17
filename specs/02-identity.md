# Spec 02: Identity Module

## Purpose
In TS, `GolemIdentity` bridges `GolemSigner` to the Ark SDK's `Identity` interface via PSBT round-trips. In Rust, this module is **entirely absorbed by the SDK** — the `KeyProvider` trait IS the identity interface. No Golem-side bridge needed.

## Rust Mapping
- `GolemIdentity` class → **Eliminated.** SDK `Client<B,W,S,K>` takes `K: KeyProvider` directly.
- `Identity.sign(tx)` → SDK calls `KeyProvider::get_keypair_for_pk()` internally during `settle()`, `send_vtxo()`, etc.
- `Identity.xOnlyPublicKey()` → `KeyProvider::get_cached_pks()` returns cached pubkeys
- `Identity.signerSession()` → SDK manages MuSig2 sessions internally (no Golem involvement)

## What Phase 1 Implements
Nothing. Use `StaticKeyProvider::new(keypair)` directly when constructing `OfflineClient::new()`.

## Test Specifications (from TS: 8 tests)

All TS identity tests validate PSBT round-trip behavior. In Rust, these are validated by the SDK's own test suite. Golem's tests should verify:

| Test | Assert |
|---|---|
| Client connects with StaticKeyProvider | `OfflineClient::new_with_keypair(...).connect().await` succeeds |
| Public key accessible | `client.get_offchain_address()` returns valid `ArkAddress` |
| Signing works via SDK | `client.send_vtxo(addr, amt).await` succeeds (integration test) |

## MuSig2 Sessions
- TS: `signerSession()` creates ephemeral random key per MuSig2 session
- Rust: SDK handles this entirely. No Golem code needed.
- Each `settle()` / `send_vtxo()` call creates its own MuSig2 session internally.
