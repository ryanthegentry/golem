import { getPublicKey, schnorr, signAsync, utils } from '@noble/secp256k1';
import type {
  GolemSigner,
  SignatureType,
  SignerInfo,
  SignerStatus,
  SignedTransaction,
  UnsignedTransaction,
} from './types.js';

/**
 * In-memory signer for testnet/PoC use.
 *
 * Holds a secp256k1 keypair in memory behind the GolemSigner interface.
 * Production signers (Tapsigner, Coldcard, etc.) swap in behind the same boundary.
 *
 * IMPORTANT: Private key never leaves this class. Not in logs, errors, or return values.
 */
export class MockSigner implements GolemSigner {
  readonly #secretKey: Uint8Array;
  readonly #publicKey: Uint8Array;

  private constructor(secretKey: Uint8Array) {
    this.#secretKey = secretKey;
    this.#publicKey = getPublicKey(secretKey, true);
  }

  /**
   * Create a MockSigner with a fresh random keypair.
   */
  static create(): MockSigner {
    return new MockSigner(utils.randomSecretKey());
  }

  /**
   * Create a MockSigner from an existing secret key.
   * Used for deterministic testing — never log the input.
   */
  static fromSecretKey(secretKey: Uint8Array): MockSigner {
    if (!utils.isValidSecretKey(secretKey)) {
      throw new Error('MockSigner: invalid secret key');
    }
    return new MockSigner(secretKey);
  }

  async getSignerInfo(): Promise<SignerInfo> {
    return {
      type: 'mock',
      label: 'MockSigner (testnet)',
      supportsDelegation: false,
    };
  }

  async getPublicKey(): Promise<Uint8Array> {
    return this.#publicKey;
  }

  /**
   * Signs the PSBT bytes using Schnorr (BIP340).
   *
   * In a real implementation this would parse the PSBT, identify inputs,
   * and sign each one. MockSigner signs the raw bytes as a proof-of-concept.
   * The actual signing flow will be shaped by Arkade SDK integration.
   */
  async signTransaction(unsignedTx: UnsignedTransaction): Promise<SignedTransaction> {
    if (!unsignedTx.psbt || unsignedTx.psbt.length === 0) {
      throw new Error('MockSigner: empty transaction data');
    }
    const signature = await schnorr.signAsync(unsignedTx.psbt, this.#secretKey);
    // Return signature concatenated with original PSBT as placeholder format.
    // Real format will be dictated by Arkade SDK.
    const signed = new Uint8Array(signature.length + unsignedTx.psbt.length);
    signed.set(signature);
    signed.set(unsignedTx.psbt, signature.length);
    return { psbt: signed };
  }

  async signMessage(message: Uint8Array, type: SignatureType): Promise<Uint8Array> {
    if (!message || message.length === 0) {
      throw new Error('MockSigner: empty message');
    }
    if (type === 'ecdsa') {
      return signAsync(message, this.#secretKey, { prehash: false });
    }
    return schnorr.signAsync(message, this.#secretKey);
  }

  async ping(): Promise<SignerStatus> {
    return {
      available: true,
      lastSeen: new Date().toISOString(),
    };
  }
}
