/**
 * Gateway init + golem.yaml tests — Feature 2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setConfigDir } from './config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-gw-test-'));
  setConfigDir(tmpDir);
});

afterEach(() => {
  setConfigDir(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Gateway config (golem.yaml)', () => {
  it('saveGatewayConfig writes valid YAML', async () => {
    const { saveGatewayConfig, loadGatewayConfig } = await import('./gateway-config.js');

    saveGatewayConfig({
      upstream: 'http://localhost:11434',
      price: 10,
      description: 'Ollama — llama3.2',
      port: 8402,
      freePaths: ['/health', '/stats'],
    });

    const loaded = loadGatewayConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.upstream).toBe('http://localhost:11434');
    expect(loaded!.price).toBe(10);
    expect(loaded!.description).toBe('Ollama — llama3.2');
  });

  it('loadGatewayConfig returns null when no file exists', async () => {
    const { loadGatewayConfig } = await import('./gateway-config.js');
    const result = loadGatewayConfig();
    expect(result).toBeNull();
  });

  it('golem.yaml is written with 0o600 permissions', async () => {
    const { saveGatewayConfig, getGatewayConfigPath } = await import('./gateway-config.js');

    saveGatewayConfig({
      upstream: 'http://localhost:11434',
      price: 10,
    });

    const stat = fs.statSync(getGatewayConfigPath());
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('gatewayConfigExists returns false when no file', async () => {
    const { gatewayConfigExists } = await import('./gateway-config.js');
    expect(gatewayConfigExists()).toBe(false);
  });

  it('gatewayConfigExists returns true after save', async () => {
    const { saveGatewayConfig, gatewayConfigExists } = await import('./gateway-config.js');
    saveGatewayConfig({ upstream: 'http://localhost:11434', price: 10 });
    expect(gatewayConfigExists()).toBe(true);
  });
});

describe('Gateway config cache fields', () => {
  it('saves and loads cache config fields', async () => {
    const { saveGatewayConfig, loadGatewayConfig } = await import('./gateway-config.js');

    saveGatewayConfig({
      upstream: 'http://localhost:11434',
      price: 10,
      cacheEnabled: true,
      cacheDefaultTtl: 1800,
      cachePricePercent: 25,
      cacheMaxSize: 5000,
    });

    const loaded = loadGatewayConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.cacheEnabled).toBe(true);
    expect(loaded!.cacheDefaultTtl).toBe(1800);
    expect(loaded!.cachePricePercent).toBe(25);
    expect(loaded!.cacheMaxSize).toBe(5000);
  });

  it('cache fields are optional (backward compat)', async () => {
    const { saveGatewayConfig, loadGatewayConfig } = await import('./gateway-config.js');

    saveGatewayConfig({
      upstream: 'http://localhost:11434',
      price: 10,
    });

    const loaded = loadGatewayConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.cacheEnabled).toBeUndefined();
    expect(loaded!.cacheDefaultTtl).toBeUndefined();
  });
});

describe('Ollama discovery', () => {
  it('returns models when Ollama is reachable', async () => {
    const { discoverOllama } = await import('../discovery/ollama.js');

    // Mock global fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.2' }, { name: 'codellama' }] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await discoverOllama('http://localhost:11434');
    expect(result).not.toBeNull();
    expect(result!.url).toBe('http://localhost:11434');
    expect(result!.models).toEqual(['llama3.2', 'codellama']);

    vi.unstubAllGlobals();
  });

  it('returns null when Ollama is unreachable', async () => {
    const { discoverOllama } = await import('../discovery/ollama.js');

    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await discoverOllama('http://localhost:11434');
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });
});

describe('Gateway command yaml fallback', () => {
  it('gateway.ts source reads from golem.yaml when flags missing', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/gateway.ts'),
      'utf-8',
    );
    expect(source).toContain('loadGatewayConfig');
    expect(source).toContain('gateway init');
  });

  it('gateway.ts has non-required --upstream and --price', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/gateway.ts'),
      'utf-8',
    );
    // Should NOT use requiredOption for upstream/price
    expect(source).not.toContain("requiredOption('--upstream");
    expect(source).not.toContain("requiredOption('--price");
    // Should use regular option
    expect(source).toContain("option('--upstream");
    expect(source).toContain("option('--price");
  });
});
