# Ark SDK Identity Interface Analysis

**SDK:** `@arkade-os/sdk` v0.3.13 ([arkade-os/ts-sdk](https://github.com/arkade-os/ts-sdk))
**Analyzed:** Feb 25, 2026

## Identity Interface

The SDK defines two interfaces in `src/identity/index.ts`:

```typescript
interface ReadonlyIdentity {
  xOnlyPublicKey(): Promise<Uint8Array>;      // 32-byte BIP340 x-only pubkey
  compressedPublicKey(): Promise<Uint8Array>;  // 33-byte compressed pubkey
}

interface Identity extends ReadonlyIdentity {
  signerSession(): SignerSession;
  signMessage(message: Uint8Array, signatureType: "schnorr" | "ecdsa"): Promise<Uint8Array>;
  sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
}
```

**Key observations:**
- `Identity` is the full signer interface. `ReadonlyIdentity` is watch-only.
- `sign()` operates on the SDK's `Transaction` class (wraps `@scure/btc-signer`), not raw PSBT bytes.
- `signMessage()` supports both Schnorr and ECDSA.
- `signerSession()` returns a `SignerSession` for MuSig2 cooperative signing (VTXO tree construction).

## Transaction Type

`src/utils/transaction.ts` — thin wrapper around `@scure/btc-signer/Transaction`:

```typescript
class Transaction extends BtcSignerTransaction {
  static ARK_TX_OPTS: TxOpts = {
    allowUnknown: true,
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
  };

  static fromPSBT(psbt: Bytes, opts?: TxOpts): Transaction;
  static fromRaw(raw: Bytes, opts?: TxOpts): Transaction;
}
```

The `sign()` method on existing Identity implementations calls `tx.sign(privateKey, sighashTypes)` or `tx.signIdx(privateKey, inputIndex, sighashTypes)` — both are `@scure/btc-signer` methods that take raw private key bytes.

## SignerSession (MuSig2)

`src/tree/signingSession.ts` defines cooperative signing for VTXO tree construction:

```typescript
interface SignerSession {
  getPublicKey(): Promise<Uint8Array>;
  init(tree: TxTree, scriptRoot: Uint8Array, rootInputAmount: bigint): Promise<void>;
  getNonces(): Promise<TreeNonces>;
  aggregatedNonces(txid: string, nonces: TreeNonces): Promise<{ hasAllNonces: boolean }>;
  sign(): Promise<TreePartialSigs>;
}
```

`TreeSignerSession` is the concrete implementation. It generates a **random ephemeral keypair** for each session (not the wallet's main key). This is used for MuSig2 nonce exchange during settlement rounds.

Both `SingleKey` and `SeedIdentity` return `TreeSignerSession.random()` from `signerSession()` — meaning the session key is independent of the wallet key.

## Existing Identity Implementations

| Class | Key Source | Notes |
|---|---|---|
| `SingleKey` | Raw private key bytes | Simplest. In-memory. |
| `SeedIdentity` | BIP32 derived from 64-byte seed | BIP86 Taproot derivation |
| `MnemonicIdentity` | BIP39 mnemonic → seed | Extends SeedIdentity |
| `ReadonlySingleKey` | Compressed public key | Watch-only |
| `ReadonlyDescriptorIdentity` | Output descriptor | Watch-only |

All signing implementations follow the same pattern:
1. Call `tx.sign(privateKey, ALL_SIGHASH)` for all inputs, or
2. Call `tx.signIdx(privateKey, inputIndex, ALL_SIGHASH)` for specific inputs

## Delegation Architecture

**Script layer** (`src/script/delegate.ts`): `DelegateVtxo.Script` extends the default VTXO script with an additional tapscript leaf containing a 3-of-3 multisig (owner + delegate + server).

**Provider layer** (`src/providers/delegator.ts`): `DelegatorProvider` / `RestDelegatorProvider` handles REST API calls to a delegator service.

**Wallet layer** (`src/wallet/delegator.ts`): `DelegatorManager` orchestrates delegation — creates signed intents, builds forfeit transactions, and submits to delegator.

The delegation flow:
1. Wallet signs an intent (register message) using `identity.sign(proof)`
2. Wallet builds forfeit transactions for each VTXO using `identity.sign(forfeitTx)`
3. Both are submitted to the delegator provider via REST

## VTXO Renewal

`VtxoManager` in `src/wallet/vtxo-manager.ts` handles renewal:
- `renewVtxos()` finds expiring VTXOs and settles them back to the wallet's own address
- Uses `wallet.settle()` which participates in an Ark round (cooperative MuSig2 signing)
- Default threshold: 3 days before expiry

## GolemIdentity Design (for Step 2)

GolemIdentity must implement `Identity` and bridge to our `GolemSigner`:

```typescript
class GolemIdentity implements Identity {
  constructor(private signer: GolemSigner) {}

  async xOnlyPublicKey(): Promise<Uint8Array> {
    const compressed = await this.signer.getPublicKey();
    return compressed.slice(1); // strip prefix byte
  }

  async compressedPublicKey(): Promise<Uint8Array> {
    return this.signer.getPublicKey();
  }

  async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
    // PROBLEM: tx.sign() and tx.signIdx() require raw private key bytes.
    // GolemSigner does NOT expose private keys.
    //
    // Options:
    // 1. Extract PSBT, send to signer, reconstruct Transaction
    // 2. Use tx.toPSBT() → signer.signTransaction() → Transaction.fromPSBT()
    // 3. Contribute upstream: add tx.signWithCallback() to @scure/btc-signer
  }

  async signMessage(message: Uint8Array, signatureType: "schnorr" | "ecdsa"): Promise<Uint8Array> {
    // GolemSigner.signTransaction() is PSBT-oriented.
    // Need a signMessage() method on GolemSigner, or handle in the bridge.
  }

  signerSession(): SignerSession {
    // MuSig2 sessions use ephemeral random keys — NOT the wallet's main key.
    // TreeSignerSession.random() is fine here.
    return TreeSignerSession.random();
  }
}
```

### Critical Gap: `sign(tx)` requires private key access

The SDK's `Transaction.sign()` (from `@scure/btc-signer`) requires the raw private key. GolemSigner intentionally never exposes it. The bridge must:

1. **Extract PSBT bytes** via `tx.toPSBT()`
2. **Send to GolemSigner** for external signing
3. **Reconstruct Transaction** via `Transaction.fromPSBT(signedPsbt)`

This means `GolemSigner.signTransaction()` must handle real PSBT signing (parse PSBT, sign relevant inputs, return signed PSBT). The current MockSigner placeholder signing is insufficient — it needs to use `@scure/btc-signer` internally.

### GolemSigner Interface Updates Needed

```typescript
interface GolemSigner {
  getSignerInfo(): Promise<SignerInfo>;
  getPublicKey(): Promise<Uint8Array>;  // 33-byte compressed

  // PSBT-based signing (for tx signing via SDK bridge)
  signTransaction(unsignedTx: UnsignedTransaction): Promise<SignedTransaction>;

  // Raw message signing (for intents, delegation proofs)
  signMessage?(message: Uint8Array, type: "schnorr" | "ecdsa"): Promise<Uint8Array>;

  getDelegationCredential?(): Promise<DelegationCredential>;
  ping(): Promise<SignerStatus>;
}
```

Adding `signMessage()` is needed because the SDK calls it directly for intent signing and delegation.

## Dependencies

The SDK uses:
- `@scure/btc-signer` — Bitcoin transaction construction and signing
- `@noble/secp256k1` — Schnorr/ECDSA signing
- `@noble/curves/secp256k1` — Curve operations for MuSig2
- `@scure/bip39` — Mnemonic handling
- `@kukks/bitcoin-descriptors` — Output descriptor parsing
