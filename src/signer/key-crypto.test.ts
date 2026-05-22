import { describe, it, expect } from 'vitest';
import {
  encryptSecretKeySync,
  decryptSecretKeySync,
  encryptSecretKeyAsync,
  decryptSecretKeyAsync,
  isEncryptedKeyData,
  SCRYPT_TEST_PARAMS,
  type EncryptedKeyData,
} from './key-crypto.js';

const TEST_KEY = [
  'e0f60aacd061005ae3e59d0540af2caa',
  'fbcb895212c180c2c1b8813a49d61d1e',
].join('');
const TEST_PASSWORD = 'testpassword123';
const P = SCRYPT_TEST_PARAMS;

describe('KeyCrypto', () => {
  describe('sync encrypt/decrypt', () => {
    it('round-trip preserves key', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      const decrypted = decryptSecretKeySync(encrypted, TEST_PASSWORD);
      expect(decrypted).toBe(TEST_KEY);
    });

    it('produces different ciphertext each call (random salt + IV)', () => {
      const a = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      const b = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      expect(a.ciphertext).not.toBe(b.ciphertext);
      expect(a.salt).not.toBe(b.salt);
      expect(a.iv).not.toBe(b.iv);
    });

    it('wrong password throws descriptive error', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      expect(() => decryptSecretKeySync(encrypted, 'wrongpassword!'))
        .toThrow('Wrong password or corrupted key data');
    });

    it('tampered ciphertext throws', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      // Flip a byte
      const bytes = Buffer.from(encrypted.ciphertext, 'hex');
      bytes[0] ^= 0xff;
      const tampered: EncryptedKeyData = { ...encrypted, ciphertext: bytes.toString('hex') };
      expect(() => decryptSecretKeySync(tampered, TEST_PASSWORD))
        .toThrow('Wrong password or corrupted key data');
    });

    it('tampered auth tag throws', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      const bytes = Buffer.from(encrypted.tag, 'hex');
      bytes[0] ^= 0xff;
      const tampered: EncryptedKeyData = { ...encrypted, tag: bytes.toString('hex') };
      expect(() => decryptSecretKeySync(tampered, TEST_PASSWORD))
        .toThrow('Wrong password or corrupted key data');
    });

    it('tampered IV throws', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      const bytes = Buffer.from(encrypted.iv, 'hex');
      bytes[0] ^= 0xff;
      const tampered: EncryptedKeyData = { ...encrypted, iv: bytes.toString('hex') };
      expect(() => decryptSecretKeySync(tampered, TEST_PASSWORD))
        .toThrow('Wrong password or corrupted key data');
    });
  });

  describe('async encrypt/decrypt', () => {
    it('round-trip preserves key', async () => {
      const encrypted = await encryptSecretKeyAsync(TEST_KEY, TEST_PASSWORD, P);
      const decrypted = await decryptSecretKeyAsync(encrypted, TEST_PASSWORD);
      expect(decrypted).toBe(TEST_KEY);
    });

    it('wrong password throws', async () => {
      const encrypted = await encryptSecretKeyAsync(TEST_KEY, TEST_PASSWORD, P);
      await expect(decryptSecretKeyAsync(encrypted, 'wrongpassword!'))
        .rejects.toThrow('Wrong password or corrupted key data');
    });
  });

  describe('sync/async cross-compatibility', () => {
    it('sync encrypt → async decrypt', async () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      const decrypted = await decryptSecretKeyAsync(encrypted, TEST_PASSWORD);
      expect(decrypted).toBe(TEST_KEY);
    });

    it('async encrypt → sync decrypt', async () => {
      const encrypted = await encryptSecretKeyAsync(TEST_KEY, TEST_PASSWORD, P);
      const decrypted = decryptSecretKeySync(encrypted, TEST_PASSWORD);
      expect(decrypted).toBe(TEST_KEY);
    });
  });

  describe('password validation', () => {
    it('rejects empty password', () => {
      expect(() => encryptSecretKeySync(TEST_KEY, '', P))
        .toThrow('Password cannot be empty');
    });

    it('rejects short password (< 8 chars)', () => {
      expect(() => encryptSecretKeySync(TEST_KEY, 'short', P))
        .toThrow('at least 8 characters');
    });

    it('accepts exactly 8-char password', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, '12345678', P);
      const decrypted = decryptSecretKeySync(encrypted, '12345678');
      expect(decrypted).toBe(TEST_KEY);
    });

    it('handles unicode passwords', () => {
      const password = 'пароль🔑test'; // mixed unicode, > 8 chars
      const encrypted = encryptSecretKeySync(TEST_KEY, password, P);
      const decrypted = decryptSecretKeySync(encrypted, password);
      expect(decrypted).toBe(TEST_KEY);
    });
  });

  describe('EncryptedKeyData structure', () => {
    it('has correct cipher and kdf fields', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      expect(encrypted.cipher).toBe('aes-256-gcm');
      expect(encrypted.kdf).toBe('scrypt');
      expect(encrypted.n).toBe(P.n);
      expect(encrypted.r).toBe(P.r);
      expect(encrypted.p).toBe(P.p);
    });

    it('all hex fields are valid hex', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      const hexRegex = /^[0-9a-f]+$/;
      expect(encrypted.salt).toMatch(hexRegex);
      expect(encrypted.iv).toMatch(hexRegex);
      expect(encrypted.tag).toMatch(hexRegex);
      expect(encrypted.ciphertext).toMatch(hexRegex);
    });

    it('error message does not contain key material', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      try {
        decryptSecretKeySync(encrypted, 'wrongpassword!');
      } catch (e) {
        expect((e as Error).message).not.toContain(TEST_KEY);
      }
    });
  });

  describe('isEncryptedKeyData type guard', () => {
    it('returns true for valid encrypted data', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      expect(isEncryptedKeyData(encrypted)).toBe(true);
    });

    it('returns false for null', () => {
      expect(isEncryptedKeyData(null)).toBe(false);
    });

    it('returns false for string', () => {
      expect(isEncryptedKeyData('not encrypted')).toBe(false);
    });

    it('returns false for partial object', () => {
      expect(isEncryptedKeyData({ cipher: 'aes-256-gcm' })).toBe(false);
    });

    it('returns false for wrong cipher', () => {
      const encrypted = encryptSecretKeySync(TEST_KEY, TEST_PASSWORD, P);
      expect(isEncryptedKeyData({ ...encrypted, cipher: 'aes-128-cbc' })).toBe(false);
    });
  });
});
