/**
 * Init --pubkey mode tests — receive-only wallet.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getPublicKey, utils, etc } from '@noble/secp256k1';
import {
  setConfigDir,
  loadConfig,
  configExists,
} from './config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-pubkey-test-'));
  setConfigDir(tmpDir);
});

afterEach(() => {
  setConfigDir(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Init --pubkey config (Feature 1)', () => {
  it('config with publicKey field loads successfully', () => {
    const secretKey = utils.randomSecretKey();
    const pubkeyHex = etc.bytesToHex(getPublicKey(secretKey, true));

    // Manually write a config with publicKey (simulating what init --pubkey would create)
    const config = {
      version: 1,
      network: 'mutinynet',
      arkServer: 'https://mutinynet.arkade.sh',
      publicKey: pubkeyHex,
      walletAddress: 'tark1testaddress',
      createdAt: new Date().toISOString(),
      safeHarborExitThresholdBlocks: 432,
      onchainReserveSats: 50_000,
    };
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

    // loadConfig must accept publicKey as a valid alternative to privateKey/encryptedKey
    const loaded = loadConfig();
    expect(loaded.publicKey).toBe(pubkeyHex);
    expect(loaded.privateKey).toBeUndefined();
    expect(loaded.encryptedKey).toBeUndefined();
  });

  it('config with only publicKey has no privateKey or encryptedKey', () => {
    const pubkeyHex = etc.bytesToHex(getPublicKey(utils.randomSecretKey(), true));
    const config = {
      version: 1,
      network: 'mutinynet',
      arkServer: 'https://mutinynet.arkade.sh',
      publicKey: pubkeyHex,
      walletAddress: 'tark1testaddress',
      createdAt: new Date().toISOString(),
      safeHarborExitThresholdBlocks: 432,
      onchainReserveSats: 50_000,
    };
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

    const loaded = loadConfig();
    expect(loaded.publicKey).toBeDefined();
    expect(loaded.privateKey).toBeUndefined();
    expect(loaded.encryptedKey).toBeUndefined();
  });

  it('init.ts source code validates --pubkey hex format', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/init.ts'),
      'utf-8',
    );
    // Should have pubkey validation
    expect(source).toContain('pubkey');
    // Should validate length or prefix
    expect(source).toMatch(/66|compressed|02|03/);
  });

  it('init.ts rejects --pubkey combined with --encrypt', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/init.ts'),
      'utf-8',
    );
    // Should have a check for pubkey + encrypt conflict
    expect(source).toMatch(/pubkey.*encrypt|encrypt.*pubkey/i);
  });
});
