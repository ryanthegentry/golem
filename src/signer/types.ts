/**
 * Signer types for Golem wallet.
 *
 * Transaction types wrap PSBT bytes. The GolemIdentity bridge converts
 * between the SDK's Transaction objects and these PSBT wrappers.
 */

export type SignerType = 'mock' | 'server' | 'mobile' | 'tapsigner' | 'coldcard';

export interface SignerInfo {
  type: SignerType;
  label: string;
  supportsDelegation: boolean;
}

export interface SignerStatus {
  available: boolean;
  lastSeen: string;
}

/** Delegation credential — deferred until Ark SDK ships high-level delegation. */
export interface DelegationCredential {
  credential: Uint8Array;
  scope: 'refresh';
  expiresAt: string;
}

/**
 * Unsigned transaction as PSBT bytes, with optional input index hints.
 * The GolemIdentity bridge populates inputIndexes when the SDK
 * requests signing of specific inputs.
 */
export interface UnsignedTransaction {
  psbt: Uint8Array;
  /** If set, only sign these input indexes. Otherwise sign all matching inputs. */
  inputIndexes?: number[];
}

export interface SignedTransaction {
  psbt: Uint8Array;
}

export type SignatureType = 'schnorr' | 'ecdsa';

/**
 * Core signer interface. All signing in Golem goes through this.
 * Production implementations swap in behind the same boundary.
 */
export interface GolemSigner {
  getSignerInfo(): Promise<SignerInfo>;
  getPublicKey(): Promise<Uint8Array>;
  signTransaction(unsignedTx: UnsignedTransaction): Promise<SignedTransaction>;
  signMessage(message: Uint8Array, type: SignatureType): Promise<Uint8Array>;
  getDelegationCredential?(): Promise<DelegationCredential>;
  ping(): Promise<SignerStatus>;
  /** Best-effort memory zeroing. JS strings returned by decryptWithKey are GC'd non-deterministically. Same limitation as LND. */
  dispose(): void;
}
