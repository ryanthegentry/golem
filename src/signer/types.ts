/**
 * Signer types for Golem wallet.
 *
 * Transaction types are thin wrappers — placeholders that define the seam.
 * Real shape will be dictated by the Arkade SDK when we integrate.
 */

export type SignerType = 'mock' | 'mobile' | 'tapsigner' | 'coldcard';

export interface SignerInfo {
  type: SignerType;
  /** Human-readable label (e.g. "MockSigner (testnet)") */
  label: string;
  /** Whether this signer supports delegation credentials */
  supportsDelegation: boolean;
}

export interface SignerStatus {
  available: boolean;
  /** ISO 8601 timestamp of last successful ping */
  lastSeen: string;
}

/**
 * Minimally-scoped credential allowing the agent to perform
 * refresh operations on behalf of the signer.
 * Shape TBD — will be defined by Ark SDK delegation primitive.
 */
export interface DelegationCredential {
  /** Opaque credential bytes. Interpretation depends on Ark SDK. */
  credential: Uint8Array;
  /** Scope of what this credential authorizes */
  scope: 'refresh';
  /** ISO 8601 expiry timestamp */
  expiresAt: string;
}

/**
 * Thin wrapper around unsigned transaction data (PSBT bytes).
 * Placeholder — real format dictated by Arkade SDK.
 */
export interface UnsignedTransaction {
  psbt: Uint8Array;
}

/**
 * Thin wrapper around signed transaction data.
 * Placeholder — real format dictated by Arkade SDK.
 */
export interface SignedTransaction {
  psbt: Uint8Array;
}

export type SignatureType = 'schnorr' | 'ecdsa';

/**
 * Core signer interface. All signing in Golem goes through this.
 *
 * Agent NEVER holds master private keys. MockSigner holds keys in memory
 * behind this interface for testnet/PoC use. Production implementations
 * (TapsignerSigner, ColdcardSigner, etc.) swap in behind the same boundary.
 *
 * The SDK's Identity interface requires both transaction signing (PSBT-based)
 * and raw message signing (for intents and delegation proofs). Both are
 * represented here.
 */
export interface GolemSigner {
  getSignerInfo(): Promise<SignerInfo>;

  /** Returns 33-byte compressed secp256k1 public key */
  getPublicKey(): Promise<Uint8Array>;

  /** Sign a PSBT. Returns signed PSBT bytes. */
  signTransaction(unsignedTx: UnsignedTransaction): Promise<SignedTransaction>;

  /**
   * Sign a raw message (for intents, delegation proofs, etc.).
   * Required by the Ark SDK Identity.signMessage() interface.
   */
  signMessage(message: Uint8Array, type: SignatureType): Promise<Uint8Array>;

  /** Optional — not all signers support delegation */
  getDelegationCredential?(): Promise<DelegationCredential>;

  ping(): Promise<SignerStatus>;
}
