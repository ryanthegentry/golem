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
} from './config.js';

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
});
