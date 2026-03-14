/**
 * ReadOnlySigner tests — pubkey-only mode, no private key.
 */

import { describe, it, expect } from 'vitest';
import { getPublicKey, utils, etc } from '@noble/secp256k1';
import { ReadOnlySigner } from './read-only-signer.js';

describe('ReadOnlySigner', () => {
  const secretKey = utils.randomSecretKey();
  const compressedPubkey = getPublicKey(secretKey, true);

  it('getPublicKey() returns the correct 33-byte key', async () => {
    const signer = new ReadOnlySigner(compressedPubkey);
    const result = await signer.getPublicKey();
    expect(result).toEqual(compressedPubkey);
    expect(result.length).toBe(33);
  });

  it('signTransaction() throws with descriptive error', async () => {
    const signer = new ReadOnlySigner(compressedPubkey);
    await expect(signer.signTransaction({ psbt: new Uint8Array([1, 2, 3]) }))
      .rejects.toThrow(/read-only|no private key/i);
  });

  it('signMessage() throws with descriptive error', async () => {
    const signer = new ReadOnlySigner(compressedPubkey);
    await expect(signer.signMessage(new Uint8Array(32).fill(1), 'schnorr'))
      .rejects.toThrow(/read-only|no private key/i);
  });

  it('dispose() is a no-op (no key to zero)', () => {
    const signer = new ReadOnlySigner(compressedPubkey);
    expect(() => signer.dispose()).not.toThrow();
    // Can call twice without issue
    expect(() => signer.dispose()).not.toThrow();
  });

  it('getSignerInfo() reports type as read-only', async () => {
    const signer = new ReadOnlySigner(compressedPubkey);
    const info = await signer.getSignerInfo();
    expect(info.type).toBe('read-only');
    expect(info.label).toContain('read-only');
  });

  it('ping() reports available', async () => {
    const signer = new ReadOnlySigner(compressedPubkey);
    const status = await signer.ping();
    expect(status.available).toBe(true);
  });

  it('rejects invalid pubkey (wrong length)', () => {
    expect(() => new ReadOnlySigner(new Uint8Array(32))).toThrow();
  });

  it('rejects invalid pubkey (bad prefix)', () => {
    const badPubkey = new Uint8Array(33);
    badPubkey[0] = 0x04; // uncompressed prefix
    expect(() => new ReadOnlySigner(badPubkey)).toThrow();
  });
});
