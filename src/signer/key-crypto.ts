/**
 * AES-256-GCM key encryption with scrypt KDF.
 *
 * Same security model as LND/CLN encrypted wallets.
 * Zero new npm dependencies — node:crypto only.
 */

import {
  randomBytes,
  scryptSync,
  scrypt,
  createCipheriv,
  createDecipheriv
} from 'node:crypto';

export interface EncryptedKeyData {
  cipher: 'aes-256-gcm';
  kdf: 'scrypt';
  salt: string;   // hex
  iv: string;     // hex
  tag: string;    // hex (GCM auth tag)
  ciphertext: string; // hex
  n: number;
  r: number;
  p: number;
}

interface ScryptParams {
  n: number;
  r: number;
  p: number;
}

/** Production: N=2^17, r=8, p=1. Memory: 128 * N * r = 128MB. ~200-300ms. */
const SCRYPT_DEFAULTS: ScryptParams = { n: 2 ** 17, r: 8, p: 1 };

/** Fast params for tests: N=2^14, ~1-2ms */
export const SCRYPT_TEST_PARAMS: ScryptParams = { n: 2 ** 14, r: 8, p: 1 };

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12;  // GCM standard
const SALT_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 8;

function validatePassword(password: string): void {
  if (!password || password.length === 0) {
    throw new Error('Password cannot be empty');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

function deriveKeySync(password: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.n * params.r,
  });
}

function deriveKeyAsync(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, {
      N: params.n,
      r: params.r,
      p: params.p,
      maxmem: 256 * params.n * params.r,
    }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function encryptWithKey(keyHex: string, derivedKey: Buffer, salt: Buffer, params: ScryptParams): EncryptedKeyData {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);

  const plaintext = Buffer.from(keyHex, 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Best-effort: Node.js strings are immutable and GC'd non-deterministically.
  // Buffer zeroing matches LND's security model.
  derivedKey.fill(0);
  plaintext.fill(0);

  return {
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    n: params.n,
    r: params.r,
    p: params.p,
  };
}

function decryptWithKey(data: EncryptedKeyData, derivedKey: Buffer): string {
  try {
    const iv = Buffer.from(data.iv, 'hex');
    const tag = Buffer.from(data.tag, 'hex');
    const ciphertext = Buffer.from(data.ciphertext, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const result = decrypted.toString('utf-8');

    // Best-effort: Node.js strings are immutable and GC'd non-deterministically.
    // Buffer zeroing matches LND's security model.
    derivedKey.fill(0);
    decrypted.fill(0);

    return result;
  } catch {
    derivedKey.fill(0);
    throw new Error('Wrong password or corrupted key data');
  }
}

/** Encrypt a secret key hex string with a password (sync scrypt — for CLI). */
export function encryptSecretKeySync(keyHex: string, password: string, params?: ScryptParams): EncryptedKeyData {
  validatePassword(password);
  const p = params ?? SCRYPT_DEFAULTS;
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = deriveKeySync(password, salt, p);
  return encryptWithKey(keyHex, derivedKey, salt, p);
}

/** Decrypt a secret key hex string with a password (sync scrypt — for CLI). */
export function decryptSecretKeySync(data: EncryptedKeyData, password: string): string {
  validatePassword(password);
  const salt = Buffer.from(data.salt, 'hex');
  const params: ScryptParams = { n: data.n, r: data.r, p: data.p };
  const derivedKey = deriveKeySync(password, salt, params);
  return decryptWithKey(data, derivedKey);
}

/** Encrypt a secret key hex string with a password (async scrypt — for servers). */
export async function encryptSecretKeyAsync(keyHex: string, password: string, params?: ScryptParams): Promise<EncryptedKeyData> {
  validatePassword(password);
  const p = params ?? SCRYPT_DEFAULTS;
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await deriveKeyAsync(password, salt, p);
  return encryptWithKey(keyHex, derivedKey, salt, p);
}

/** Decrypt a secret key hex string with a password (async scrypt — for servers). */
export async function decryptSecretKeyAsync(data: EncryptedKeyData, password: string): Promise<string> {
  validatePassword(password);
  const salt = Buffer.from(data.salt, 'hex');
  const params: ScryptParams = { n: data.n, r: data.r, p: data.p };
  const derivedKey = await deriveKeyAsync(password, salt, params);
  return decryptWithKey(data, derivedKey);
}

/** Type guard: is this object an EncryptedKeyData? */
export function isEncryptedKeyData(obj: unknown): obj is EncryptedKeyData {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    o.cipher === 'aes-256-gcm' &&
    o.kdf === 'scrypt' &&
    typeof o.salt === 'string' &&
    typeof o.iv === 'string' &&
    typeof o.tag === 'string' &&
    typeof o.ciphertext === 'string' &&
    typeof o.n === 'number' &&
    typeof o.r === 'number' &&
    typeof o.p === 'number'
  );
}
