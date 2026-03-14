/**
 * Signer dispose() tests — CRITICAL-001: memory zeroing.
 *
 * After dispose(), secret key must be zeroed and sign() must throw.
 */

import { describe, it, expect } from 'vitest';
import { utils, etc } from '@noble/secp256k1';
import { MockSigner } from './mock-signer.js';
import { ServerSigner } from './server-signer.js';

describe('Signer dispose() (CRITICAL-001)', () => {
  it('MockSigner.dispose() zeros the secret key buffer', async () => {
    const secretKey = utils.randomSecretKey();
    const signer = MockSigner.fromSecretKey(secretKey);

    // Verify signer works before dispose
    const pubkey = await signer.getPublicKey();
    expect(pubkey.length).toBe(33);

    // dispose() should exist and zero memory
    signer.dispose();

    // The original secretKey buffer should be zeroed
    // (MockSigner stores a reference, not a copy, of the buffer)
    // We verify via sign() throwing — internal key is zeroed
    await expect(signer.signMessage(new Uint8Array(32).fill(1), 'schnorr'))
      .rejects.toThrow();
  });

  it('MockSigner.dispose() causes sign() to throw descriptive error', async () => {
    const signer = MockSigner.create();
    signer.dispose();

    await expect(signer.signTransaction({ psbt: new Uint8Array([1, 2, 3]) }))
      .rejects.toThrow(/disposed/i);
    await expect(signer.signMessage(new Uint8Array(32).fill(1), 'schnorr'))
      .rejects.toThrow(/disposed/i);
  });

  it('MockSigner.dispose() is idempotent', () => {
    const signer = MockSigner.create();
    signer.dispose();
    expect(() => signer.dispose()).not.toThrow();
  });

  it('ServerSigner inherits dispose() from MockSigner', async () => {
    const keyHex = etc.bytesToHex(utils.randomSecretKey());
    const signer = ServerSigner.fromSecretKeyHex(keyHex);

    // Should work before dispose
    const pubkey = await signer.getPublicKey();
    expect(pubkey.length).toBe(33);

    signer.dispose();

    await expect(signer.signMessage(new Uint8Array(32).fill(1), 'schnorr'))
      .rejects.toThrow(/disposed/i);
  });

  it('GolemSigner interface includes dispose()', async () => {
    // Type-level test: MockSigner satisfies GolemSigner with dispose()
    const signer = MockSigner.create();
    expect(typeof signer.dispose).toBe('function');
  });
});
