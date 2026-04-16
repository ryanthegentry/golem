# Spec 09: Covenant Module

## Purpose
Keyless covenant-based VTXO construction for Phase 1.5. Three-leaf taptree with refresh (Introspector-enforced), collaborative (Alice+Server), and unilateral exit (Alice-only with CSV). Arkade Script encoding for introspection opcodes.

## Rust Mapping
- Script construction → `bitcoin::script::Builder`
- Custom tapscript leaves → `Vtxo::new_with_custom_scripts()` (SDK)
- Covenant tx submission → gRPC (`submit_offchain_transaction_request`, `finalize_offchain_transaction`)
- Introspector interaction → HTTP POST to separate Introspector service

## Arkade Script Builders

### Claim Script

```rust
/// Build claim arkade script for covenant claim operation
/// preimage_hash: 20-byte HASH160
/// recipient_wp: 32-byte witness program
/// min_amount: minimum output value in sats
pub fn build_claim_arkade_script(
    preimage_hash: &[u8; 20],
    recipient_wp: &[u8; 32],
    min_amount: u64,
) -> Vec<u8>;
```

**Bytecode:**
```
OP_HASH160 PUSH20 <hash> OP_EQUALVERIFY
OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_1 OP_EQUALVERIFY
PUSH32 <wp> OP_EQUALVERIFY
OP_0 OP_INSPECTOUTPUTVALUE PUSH8 <le_amount> OP_GTE64
```

### Refresh Script

```rust
/// Build refresh arkade script (stateless, always same output)
pub fn build_refresh_arkade_script() -> Vec<u8>;
```

**Bytecode:** `OP_0 OP_INSPECTOUTPUTSCRIPTPUBKEY OP_0 OP_INSPECTINPUTSCRIPTPUBKEY OP_ROT OP_EQUALVERIFY OP_EQUAL`
Full recursive covenant: enforces input[0].scriptPubKey == output[0].scriptPubKey. Enabled by Introspector PR #63 (OP_INSPECTINPUTSCRIPTPUBKEY traces through checkpoint wrappers).

## Crypto Primitives

```rust
/// BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data)
pub fn tagged_hash(tag: &str, data: &[u8]) -> [u8; 32];

/// ArkadeScriptHash = tagged_hash("ArkScriptHash", script)
pub fn arkade_script_hash(script: &[u8]) -> [u8; 32];

/// Compute tweaked key: base_point + H("ArkScriptHash", script) * G
pub fn compute_tweaked_key(
    base_pubkey_xonly: &XOnlyPublicKey,
    script_hash: &[u8; 32],
) -> XOnlyPublicKey;
```

## Three-Leaf Covenant VTXO

```rust
pub struct CovenantVtxo {
    pub vtxo: Vtxo,  // SDK Vtxo with custom scripts
    pub refresh_arkade_script: Vec<u8>,
    pub refresh_tweaked_key: XOnlyPublicKey,
    pub refresh_leaf_script: ScriptBuf,
    pub collaborative_script: ScriptBuf,
}

pub fn build_covenant_vtxo(
    alice_pubkey: &XOnlyPublicKey,
    server_pubkey: &XOnlyPublicKey,
    introspector_base_pubkey: &XOnlyPublicKey,
    unilateral_exit_delay: Sequence,
) -> Result<CovenantVtxo, Error>;
```

**Three leaves:**
1. **Refresh (forfeit):** `multisig(tweaked_introspector_key, server_key)` — Introspector signs with pubkey tweaked by arkade_script_hash
2. **Collaborative (forfeit):** `multisig(alice_key, server_key)` — Standard Ark spending
3. **Unilateral exit:** `csv_multisig(exit_delay, alice_key)` — Emergency escape

**Constraint:** arkd's `Validate()` requires server pubkey in every forfeit closure. Alice-only MultisigClosure fails validation.

## Introspector Packet

```rust
/// Build OP_RETURN with Introspector Packet
pub fn build_op_return_script(entries: &[IntrospectorEntry]) -> Vec<u8>;

pub struct IntrospectorEntry {
    pub vin: u16,
    pub script: Vec<u8>,
    pub witness: Option<Vec<u8>>,
}

/// Encode witness stack (standard Bitcoin witness format)
pub fn encode_witness_stack(items: &[Vec<u8>]) -> Vec<u8>;
```

**Packet format:** Magic "ARK" (0x41 0x52 0x4b) + TLV(tag=0x01, entries sorted by vin)

## Introspector Submission Flow

```rust
/// Submit PSBT to Introspector for signing
pub async fn submit_introspector_tx(
    introspector_url: &str,
    ark_tx_psbt: &[u8],
    checkpoint_psbts: &[Vec<u8>],
) -> Result<(Vec<u8>, Vec<Vec<u8>>), Error>;

/// Full 4-step covenant tx submission
pub async fn submit_covenant_tx(
    introspector_url: &str,
    ark_tx: &Psbt,
    checkpoints: &[Psbt],
    grpc_client: &ark_grpc::Client,
) -> Result<Txid, Error>;
```

**4-step flow:**
1. Introspector signs ark_tx + checkpoints
2. arkd co-signs (via gRPC `submit_offchain_transaction_request`)
3. Introspector re-signs checkpoints (arkd created new PSBTs)
4. Finalize (via gRPC `finalize_offchain_transaction`)

## Encoding Utilities

```rust
pub fn encode_varint(n: u64) -> Vec<u8>;   // Bitcoin varint
pub fn encode_uvarint(n: u64) -> Vec<u8>;  // LEB128
```

## Test Specifications (covenant tests are in golem-ark-TS but count is lower — ~20 tests)

| Test | Assert |
|---|---|
| Claim script rejects wrong preimage_hash length | != 20 bytes → error |
| Claim script rejects wrong wp length | != 32 bytes → error |
| Claim script encodes amount as LE 8-byte | Verified against known bytecode |
| Refresh script is stateless | Always same output |
| Tagged hash matches BIP-340 | Known test vector |
| Tweaked key is deterministic | Same inputs → same key |
| Three-leaf VTXO has correct structure | 3 scripts in taptree |
| Introspector packet has ARK magic | First 3 bytes = 0x41 0x52 0x4b |
| OP_RETURN push opcode correct | <=75, <=255, >255 variants |
| Varint encoding | n < 253: 1 byte; 253-65535: 3 bytes |
