/**
 * ReadOnlySigner — pubkey-only signer for receive-only wallets.
 *
 * Provides the public key for address derivation and balance queries.
 * All signing operations throw — the private key is held elsewhere
 * (mobile app, hardware signer, or future covenant path).
 */

import type {
  GolemSigner,
  SignatureType,
  SignerInfo,
  SignerStatus,
  SignedTransaction,
  UnsignedTransaction,
} from './types.js';

export class ReadOnlySigner implements GolemSigner {
  readonly #publicKey: Uint8Array;

  constructor(compressedPubkey: Uint8Array) {
    if (compressedPubkey.length !== 33) {
      throw new Error(`ReadOnlySigner: expected 33-byte compressed pubkey, got ${compressedPubkey.length} bytes`);
    }
    if (compressedPubkey[0] !== 0x02 && compressedPubkey[0] !== 0x03) {
      throw new Error(`ReadOnlySigner: invalid compressed pubkey prefix 0x${compressedPubkey[0].toString(16).padStart(2, '0')}`);
    }
    this.#publicKey = compressedPubkey;
  }

  async getSignerInfo(): Promise<SignerInfo> {
    return {
      type: 'read-only',
      label: 'ReadOnlySigner (read-only, no private key)',
      supportsDelegation: false,
    };
  }

  async getPublicKey(): Promise<Uint8Array> {
    return this.#publicKey;
  }

  async signTransaction(_unsignedTx: UnsignedTransaction): Promise<SignedTransaction> {
    throw new Error('ReadOnlySigner: no private key available — wallet is in read-only mode');
  }

  async signMessage(_message: Uint8Array, _type: SignatureType): Promise<Uint8Array> {
    throw new Error('ReadOnlySigner: no private key available — wallet is in read-only mode');
  }

  async ping(): Promise<SignerStatus> {
    return {
      available: true,
      lastSeen: new Date().toISOString(),
    };
  }

  dispose(): void {
    // No-op — no secret key material to zero
  }
}
