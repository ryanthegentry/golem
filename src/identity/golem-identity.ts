import type { Identity, SignerSession } from '@arkade-os/sdk';
import { SingleKey, Transaction } from '@arkade-os/sdk';
import type { GolemSigner } from '../signer/types.js';

/**
 * Bridge GolemSigner → Ark SDK Identity via PSBT round-trip.
 * Key never leaves the signer; MuSig2 sessions use ephemeral SingleKey.
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

  /** Sign via PSBT round-trip: extract → signer.signTransaction → reconstruct. */
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

  /** MuSig2 sessions use ephemeral random keys — throwaway SingleKey. */
  signerSession(): SignerSession {
    return SingleKey.fromRandomBytes().signerSession();
  }
}
