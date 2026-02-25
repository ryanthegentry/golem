import { Transaction, SigHash } from '@scure/btc-signer';
import { getPublicKey, schnorr, signAsync, utils } from '@noble/secp256k1';
import type {
  GolemSigner,
  SignatureType,
  SignerInfo,
  SignerStatus,
  SignedTransaction,
  UnsignedTransaction,
} from './types.js';

const ALL_SIGHASH = Object.values(SigHash).filter(
  (x): x is number => typeof x === 'number',
);

const PSBT_TX_OPTS = {
  allowUnknown: true,
  allowUnknownOutputs: true,
  allowUnknownInputs: true,
} as const;

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
   * Parse PSBT, sign matching inputs with the in-memory key, return signed PSBT.
   * Supports both signing all inputs and signing specific input indexes.
   */
  async signTransaction(unsignedTx: UnsignedTransaction): Promise<SignedTransaction> {
    if (!unsignedTx.psbt || unsignedTx.psbt.length === 0) {
      throw new Error('MockSigner: empty transaction data');
    }

    const tx = Transaction.fromPSBT(unsignedTx.psbt, PSBT_TX_OPTS);

    if (unsignedTx.inputIndexes) {
      for (const idx of unsignedTx.inputIndexes) {
        tx.signIdx(this.#secretKey, idx, ALL_SIGHASH);
      }
    } else {
      tx.sign(this.#secretKey, ALL_SIGHASH);
    }

    return { psbt: tx.toPSBT() };
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
