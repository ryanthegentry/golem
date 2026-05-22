import { describe, it, expect } from 'vitest';
import { etc } from '@noble/secp256k1';
import { ServerSigner } from './server-signer.js';
import { encryptSecretKeySync, SCRYPT_TEST_PARAMS } from './key-crypto.js';

const TEST_KEY_HEX = [
  'e0f60aacd061005ae3e59d0540af2caa',
  'fbcb895212c180c2c1b8813a49d61d1e',
].join('');
const TEST_PASSWORD = 'testpassword123';
const P = SCRYPT_TEST_PARAMS;

describe('ServerSigner', () => {
  it('fromSecretKeyHex creates working signer', async () => {
    const signer = ServerSigner.fromSecretKeyHex(TEST_KEY_HEX);
    const pubkey = await signer.getPublicKey();
    expect(pubkey).toBeInstanceOf(Uint8Array);
    expect(pubkey.length).toBe(33);
  });

  it('fromEncrypted creates working signer', () => {
    const encrypted = encryptSecretKeySync(TEST_KEY_HEX, TEST_PASSWORD, P);
    const signer = ServerSigner.fromEncrypted(encrypted, TEST_PASSWORD);
    expect(signer).toBeInstanceOf(ServerSigner);
  });

  it('fromEncryptedAsync creates working signer', async () => {
    const encrypted = encryptSecretKeySync(TEST_KEY_HEX, TEST_PASSWORD, P);
    const signer = await ServerSigner.fromEncryptedAsync(encrypted, TEST_PASSWORD);
    const pubkey = await signer.getPublicKey();
    expect(pubkey.length).toBe(33);
  });

  it('encrypted and plaintext produce same public key', async () => {
    const encrypted = encryptSecretKeySync(TEST_KEY_HEX, TEST_PASSWORD, P);
    const fromHex = ServerSigner.fromSecretKeyHex(TEST_KEY_HEX);
    const fromEnc = ServerSigner.fromEncrypted(encrypted, TEST_PASSWORD);

    const key1 = etc.bytesToHex(await fromHex.getPublicKey());
    const key2 = etc.bytesToHex(await fromEnc.getPublicKey());
    expect(key1).toBe(key2);
  });

  it('getSignerInfo reports type server', async () => {
    const signer = ServerSigner.fromSecretKeyHex(TEST_KEY_HEX);
    const info = await signer.getSignerInfo();
    expect(info.type).toBe('server');
    expect(info.label).toContain('ServerSigner');
    expect(info.supportsDelegation).toBe(false);
  });

  it('encrypted signer reports encrypted label', async () => {
    const encrypted = encryptSecretKeySync(TEST_KEY_HEX, TEST_PASSWORD, P);
    const signer = ServerSigner.fromEncrypted(encrypted, TEST_PASSWORD);
    const info = await signer.getSignerInfo();
    expect(info.label).toContain('encrypted at rest');
  });

  it('plaintext signer reports plaintext label', async () => {
    const signer = ServerSigner.fromSecretKeyHex(TEST_KEY_HEX);
    const info = await signer.getSignerInfo();
    expect(info.label).toContain('plaintext');
  });

  it('fromEncrypted with wrong password throws', () => {
    const encrypted = encryptSecretKeySync(TEST_KEY_HEX, TEST_PASSWORD, P);
    expect(() => ServerSigner.fromEncrypted(encrypted, 'wrongpassword!'))
      .toThrow('Wrong password or corrupted key data');
  });

  it('ping reports available', async () => {
    const signer = ServerSigner.fromSecretKeyHex(TEST_KEY_HEX);
    const status = await signer.ping();
    expect(status.available).toBe(true);
  });

  it('signMessage delegates to inner signer', async () => {
    const signer = ServerSigner.fromSecretKeyHex(TEST_KEY_HEX);
    const message = new TextEncoder().encode('test message');
    const sig = await signer.signMessage(message, 'schnorr');
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });
});
