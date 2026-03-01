/**
 * ServerSigner — encrypted-at-rest signer for Phase 1.
 *
 * Extends MockSigner with decrypt-from-config support. Reports type 'server'
 * and provides static constructors for both plaintext and encrypted keys.
 */

import { MockSigner } from './mock-signer.js';
import { decryptSecretKeySync, decryptSecretKeyAsync, type EncryptedKeyData } from './key-crypto.js';
import type { SignerInfo } from './types.js';

export class ServerSigner extends MockSigner {
  readonly #encrypted: boolean;

  private constructor(secretKey: Uint8Array, encrypted: boolean) {
    super(secretKey);
    this.#encrypted = encrypted;
  }

  /**
   * Create from a plaintext hex secret key (backward compat with GOLEM_SIGNER_KEY).
   *
   * The key lives in memory for the process lifetime — same security model as LND/CLN.
   */
  static fromSecretKeyHex(hex: string): ServerSigner {
    return new ServerSigner(Buffer.from(hex, 'hex'), false);
  }

  /** Decrypt and create (sync — for CLI). */
  static fromEncrypted(data: EncryptedKeyData, password: string): ServerSigner {
    const keyHex = decryptSecretKeySync(data, password);
    return new ServerSigner(Buffer.from(keyHex, 'hex'), true);
  }

  /** Decrypt and create (async — for servers, non-blocking scrypt). */
  static async fromEncryptedAsync(data: EncryptedKeyData, password: string): Promise<ServerSigner> {
    const keyHex = await decryptSecretKeyAsync(data, password);
    return new ServerSigner(Buffer.from(keyHex, 'hex'), true);
  }

  override async getSignerInfo(): Promise<SignerInfo> {
    return {
      type: 'server',
      label: this.#encrypted ? 'ServerSigner (encrypted at rest)' : 'ServerSigner (plaintext)',
      supportsDelegation: false,
    };
  }
}
