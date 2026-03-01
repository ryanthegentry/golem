import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type GolemConfig,
  setConfigDir,
  getConfigPath,
  configExists,
  loadConfig,
  saveConfig,
  configRequiresPassword,
} from './config.js';
import { encryptSecretKeySync, SCRYPT_TEST_PARAMS } from '../signer/key-crypto.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-test-'));
  setConfigDir(tmpDir);
});

afterEach(() => {
  setConfigDir(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function validConfig(): GolemConfig {
  return {
    version: 1,
    network: 'mutinynet',
    arkServer: 'https://mutinynet.arkade.sh',
    privateKey: 'a'.repeat(64),
    walletAddress: 'ark1testaddress',
    createdAt: new Date().toISOString(),
    safeHarborExitThresholdBlocks: 432,
    onchainReserveSats: 50_000,
  };
}

describe('CLI config', () => {
  it('configExists returns false for empty dir', () => {
    expect(configExists()).toBe(false);
  });

  it('saveConfig creates valid config file', () => {
    const config = validConfig();
    saveConfig(config);
    expect(configExists()).toBe(true);

    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.network).toBe('mutinynet');
  });

  it('loadConfig reads saved config', () => {
    const config = validConfig();
    saveConfig(config);

    const loaded = loadConfig();
    expect(loaded.version).toBe(config.version);
    expect(loaded.network).toBe(config.network);
    expect(loaded.arkServer).toBe(config.arkServer);
    expect(loaded.privateKey).toBe(config.privateKey);
    expect(loaded.walletAddress).toBe(config.walletAddress);
    expect(loaded.createdAt).toBe(config.createdAt);
  });

  it('loadConfig throws when no config exists', () => {
    expect(() => loadConfig()).toThrow("Run 'golem init' first");
  });

  it('loadConfig throws on invalid config structure', () => {
    fs.writeFileSync(getConfigPath(), JSON.stringify({ version: 1 }), 'utf-8');
    expect(() => loadConfig()).toThrow('Invalid config');
  });

  it('config roundtrip preserves all fields', () => {
    const config = validConfig();
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded).toEqual(config);
  });

  it('saveConfig overwrites existing config', () => {
    saveConfig(validConfig());
    const updated = { ...validConfig(), network: 'signet' };
    saveConfig(updated);

    const loaded = loadConfig();
    expect(loaded.network).toBe('signet');
  });

  it('loadConfig backfills safe harbor defaults for old configs', () => {
    // Simulate a config saved before safe harbor fields were added
    const oldConfig = {
      version: 1,
      network: 'mutinynet',
      arkServer: 'https://mutinynet.arkade.sh',
      privateKey: 'a'.repeat(64),
      walletAddress: 'ark1testaddress',
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(oldConfig), 'utf-8');

    const loaded = loadConfig();
    expect(loaded.safeHarborExitThresholdBlocks).toBe(432);
    expect(loaded.onchainReserveSats).toBe(50_000);
    expect(loaded.safeHarborAddress).toBeUndefined();
  });

  it('config preserves safeHarborAddress when set', () => {
    const config = { ...validConfig(), safeHarborAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' };
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded.safeHarborAddress).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  });
});

describe('Encrypted config', () => {
  const TEST_PASSWORD = 'testpassword123';

  function encryptedConfig(): GolemConfig {
    const keyHex = 'b'.repeat(64);
    return {
      version: 1,
      network: 'mutinynet',
      arkServer: 'https://mutinynet.arkade.sh',
      encryptedKey: encryptSecretKeySync(keyHex, TEST_PASSWORD, SCRYPT_TEST_PARAMS),
      walletAddress: 'ark1testaddress',
      createdAt: new Date().toISOString(),
      safeHarborExitThresholdBlocks: 432,
      onchainReserveSats: 50_000,
    };
  }

  it('saveConfig + loadConfig roundtrip with encrypted key', () => {
    const config = encryptedConfig();
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded.encryptedKey).toBeDefined();
    expect(loaded.encryptedKey!.cipher).toBe('aes-256-gcm');
    expect(loaded.privateKey).toBeUndefined();
  });

  it('loadConfig accepts config with only encryptedKey (no privateKey)', () => {
    const config = encryptedConfig();
    saveConfig(config);
    expect(() => loadConfig()).not.toThrow();
  });

  it('loadConfig rejects config with neither privateKey nor encryptedKey', () => {
    const config = {
      version: 1,
      network: 'mutinynet',
      arkServer: 'https://mutinynet.arkade.sh',
      walletAddress: 'ark1testaddress',
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(config), 'utf-8');
    expect(() => loadConfig()).toThrow('Invalid config');
  });

  it('configRequiresPassword returns true for encrypted config', () => {
    const config = encryptedConfig();
    expect(configRequiresPassword(config)).toBe(true);
  });

  it('configRequiresPassword returns false for plaintext config', () => {
    const config = validConfig();
    expect(configRequiresPassword(config)).toBe(false);
  });

  it('saveConfig sets 0600 permissions on config file', () => {
    const config = validConfig();
    saveConfig(config);
    const stat = fs.statSync(getConfigPath());
    // Check owner-only read/write (0600 = 0o600 = 384 decimal)
    // stat.mode includes file type bits, mask with 0o777
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});
