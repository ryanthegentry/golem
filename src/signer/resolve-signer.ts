import { utils } from '@noble/secp256k1';
import { ServerSigner } from './server-signer.js';
import { loadConfig, configExists, configRequiresPassword } from '../cli/config.js';
import type { GolemSigner } from './types.js';

/** Validate a hex key string is exactly 64 hex chars and a valid secp256k1 scalar. */
function validateSignerKeyHex(hex: string): void {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      'GOLEM_SIGNER_KEY must be exactly 64 hex characters (32 bytes). ' +
      `Got ${hex.length} characters.`
    );
  }
  if (!utils.isValidSecretKey(Buffer.from(hex, 'hex'))) {
    throw new Error('GOLEM_SIGNER_KEY is not a valid secp256k1 secret key (out of range).');
  }
}

// Priority: 1) GOLEM_SIGNER_KEY env var  2) ~/.golem/config.json (encrypted needs GOLEM_PASSWORD)
export async function resolveServerSigner(): Promise<GolemSigner> {
  const signerKey = process.env.GOLEM_SIGNER_KEY;
  if (signerKey) {
    validateSignerKeyHex(signerKey);
    return ServerSigner.fromSecretKeyHex(signerKey);
  }

  if (!configExists()) {
    throw new Error('Set GOLEM_SIGNER_KEY env var or run \'golem init\' first.');
  }

  const config = loadConfig();
  if (configRequiresPassword(config)) {
    const password = process.env.GOLEM_PASSWORD;
    if (!password) {
      throw new Error('Encrypted wallet config found. Set GOLEM_PASSWORD env var.');
    }
    return ServerSigner.fromEncryptedAsync(config.encryptedKey!, password);
  }

  if (config.privateKey) {
    return ServerSigner.fromSecretKeyHex(config.privateKey);
  }

  throw new Error('Config has no key. Run \'golem init\' first.');
}
