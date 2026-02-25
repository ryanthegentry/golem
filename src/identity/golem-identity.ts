import type { Identity, SignerSession } from '@arkade-os/sdk';
import { SingleKey, Transaction } from '@arkade-os/sdk';
import type { GolemSigner } from '../signer/types.js';

/**
 * Bridge between GolemSigner and the Ark SDK's Identity interface.
 *
 * The SDK expects an Identity that can sign Transactions and messages.
 * Existing SDK implementations (SingleKey, SeedIdentity) call
 * tx.sign(privateKey) internally — requiring raw key access.
 *
 * GolemIdentity avoids this by extracting PSBT bytes, routing them
 * through the GolemSigner (which holds the key), and reconstructing
 * the Transaction from signed PSBT bytes.
 *
 * MuSig2 signer sessions use ephemeral random keys independent of
 * the wallet key, so we delegate to SingleKey for that.
 */
export class GolemIdentity implements Identity {
  constructor(private readonly signer: GolemSigner) {}

  async xOnlyPublicKey(): Promise<Uint8Array> {
    const compressed = await this.signer.getPublicKey();
    return compressed.slice(1); // strip 02/03 prefix → 32-byte x-only
  }

  async compressedPublicKey(): Promise<Uint8Array> {
    return this.signer.getPublicKey();
  }

  /**
   * Sign a Transaction by round-tripping through PSBT.
   *
   * 1. Extract PSBT bytes from the SDK Transaction
   * 2. Send to GolemSigner for signing (key never leaves the signer)
   * 3. Reconstruct a signed Transaction from the result
   */
  async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
    const psbtBytes = tx.toPSBT();

    const signed = await this.signer.signTransaction({
      psbt: psbtBytes,
      inputIndexes,
    });

    return Transaction.fromPSBT(signed.psbt);
  }

  async signMessage(
    message: Uint8Array,
    signatureType: 'schnorr' | 'ecdsa' = 'schnorr',
  ): Promise<Uint8Array> {
    return this.signer.signMessage(message, signatureType);
  }

  /**
   * MuSig2 signer sessions use ephemeral random keys that are
   * independent of the wallet's main key. A throwaway SingleKey
   * provides the session — its main key is never used for signing.
   */
  signerSession(): SignerSession {
    return SingleKey.fromRandomBytes().signerSession();
  }
}
