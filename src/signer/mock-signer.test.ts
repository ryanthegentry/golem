import { describe, it, expect } from 'vitest';
import { schnorr, verifyAsync, etc } from '@noble/secp256k1';
import { MockSigner } from './mock-signer.js';

describe('MockSigner', () => {
  it('creates a valid instance', () => {
    const signer = MockSigner.create();
    expect(signer).toBeInstanceOf(MockSigner);
  });

  it('getPublicKey returns a 33-byte compressed secp256k1 key', async () => {
    const signer = MockSigner.create();
    const pubkey = await signer.getPublicKey();
    expect(pubkey).toBeInstanceOf(Uint8Array);
    expect(pubkey.length).toBe(33);
    // Compressed keys start with 0x02 or 0x03
    expect([0x02, 0x03]).toContain(pubkey[0]);
  });

  it('getPublicKey returns consistent key across calls', async () => {
    const signer = MockSigner.create();
    const key1 = await signer.getPublicKey();
    const key2 = await signer.getPublicKey();
    expect(etc.bytesToHex(key1)).toBe(etc.bytesToHex(key2));
  });

  it('fromSecretKey produces deterministic public key', async () => {
    const secret = new Uint8Array(32);
    secret[31] = 1; // minimal valid secret key
    const signer1 = MockSigner.fromSecretKey(secret);
    const signer2 = MockSigner.fromSecretKey(secret);
    const key1 = await signer1.getPublicKey();
    const key2 = await signer2.getPublicKey();
    expect(etc.bytesToHex(key1)).toBe(etc.bytesToHex(key2));
  });

  it('fromSecretKey rejects invalid key', () => {
    const zeros = new Uint8Array(32); // all zeros = invalid
    expect(() => MockSigner.fromSecretKey(zeros)).toThrow('invalid secret key');
  });

  it('signTransaction produces a verifiable Schnorr signature', async () => {
    const signer = MockSigner.create();
    const pubkey = await signer.getPublicKey();
    const message = new TextEncoder().encode('test transaction data');
    const result = await signer.signTransaction({ psbt: message });

    expect(result.psbt).toBeInstanceOf(Uint8Array);
    // Schnorr sig is 64 bytes, so result = 64 + message.length
    expect(result.psbt.length).toBe(64 + message.length);

    // Extract signature and verify against Schnorr x-only pubkey (bytes 1..33)
    const sig = result.psbt.slice(0, 64);
    const xOnlyPubkey = pubkey.slice(1); // strip prefix byte for BIP340
    const valid = await schnorr.verifyAsync(sig, message, xOnlyPubkey);
    expect(valid).toBe(true);
  });

  it('signTransaction rejects empty data', async () => {
    const signer = MockSigner.create();
    await expect(signer.signTransaction({ psbt: new Uint8Array(0) }))
      .rejects.toThrow('empty transaction data');
  });

  it('ping reports available', async () => {
    const signer = MockSigner.create();
    const status = await signer.ping();
    expect(status.available).toBe(true);
    expect(status.lastSeen).toBeTruthy();
    // Verify it's a valid ISO timestamp
    expect(new Date(status.lastSeen).toISOString()).toBe(status.lastSeen);
  });

  it('getSignerInfo returns correct metadata', async () => {
    const signer = MockSigner.create();
    const info = await signer.getSignerInfo();
    expect(info.type).toBe('mock');
    expect(info.label).toContain('MockSigner');
    expect(info.supportsDelegation).toBe(false);
  });

  it('does not expose private key material in errors', async () => {
    const secret = new Uint8Array(32);
    secret[31] = 1;
    const signer = MockSigner.fromSecretKey(secret);
    const secretHex = etc.bytesToHex(secret);

    // Verify the signer works
    const pubkey = await signer.getPublicKey();
    expect(pubkey).toBeInstanceOf(Uint8Array);

    // Trigger an error and verify no key material in the message
    try {
      await signer.signTransaction({ psbt: new Uint8Array(0) });
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(secretHex);
    }

    // Verify toString/JSON don't leak keys
    const str = String(signer);
    expect(str).not.toContain(secretHex);
    const json = JSON.stringify(signer);
    expect(json).not.toContain(secretHex);
  });

  it('signMessage with schnorr produces verifiable signature', async () => {
    const signer = MockSigner.create();
    const pubkey = await signer.getPublicKey();
    const message = new TextEncoder().encode('test message');
    const sig = await signer.signMessage(message, 'schnorr');

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);

    const xOnlyPubkey = pubkey.slice(1);
    const valid = await schnorr.verifyAsync(sig, message, xOnlyPubkey);
    expect(valid).toBe(true);
  });

  it('signMessage with ecdsa produces verifiable signature', async () => {
    const signer = MockSigner.create();
    const pubkey = await signer.getPublicKey();
    const message = new Uint8Array(32); // pre-hashed 32-byte message
    message[0] = 0xab;
    const sig = await signer.signMessage(message, 'ecdsa');

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64); // compact ECDSA sig

    const valid = await verifyAsync(sig, message, pubkey, { prehash: false });
    expect(valid).toBe(true);
  });

  it('signMessage rejects empty message', async () => {
    const signer = MockSigner.create();
    await expect(signer.signMessage(new Uint8Array(0), 'schnorr'))
      .rejects.toThrow('empty message');
  });

  it('two signers produce different keys', async () => {
    const signer1 = MockSigner.create();
    const signer2 = MockSigner.create();
    const key1 = await signer1.getPublicKey();
    const key2 = await signer2.getPublicKey();
    expect(etc.bytesToHex(key1)).not.toBe(etc.bytesToHex(key2));
  });
});
