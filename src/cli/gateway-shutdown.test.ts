/**
 * Gateway shutdown handler source inspection tests.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Gateway shutdown handlers', () => {
  it('CLI gateway.ts handles both SIGINT and SIGTERM', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/gateway.ts'),
      'utf-8',
    );
    expect(source).toContain("'SIGINT'");
    expect(source).toContain("'SIGTERM'");
  });

  it('CLI gateway.ts calls wallet.dispose() on shutdown', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/gateway.ts'),
      'utf-8',
    );
    expect(source).toContain('wallet.dispose()');
  });

  it('gateway-server.ts handles both SIGINT and SIGTERM', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '../l402/gateway-server.ts'),
      'utf-8',
    );
    expect(source).toContain("'SIGINT'");
    expect(source).toContain("'SIGTERM'");
  });

  it('gateway-server.ts calls signer.dispose() on shutdown', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '../l402/gateway-server.ts'),
      'utf-8',
    );
    expect(source).toContain('signer.dispose()');
  });

  it('CLI gateway.ts has self-proxy detection', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/gateway.ts'),
      'utf-8',
    );
    expect(source).toMatch(/self.proxy|self-proxy|proxy.*self|localhost.*port|same.*port/i);
  });

  it('CLI gateway.ts validates upstream URL', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/gateway.ts'),
      'utf-8',
    );
    expect(source).toContain('new URL');
  });

  it('CLI gateway.ts has .catch() on registration promise', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/gateway.ts'),
      'utf-8',
    );
    // The .then() chain must have a .catch()
    expect(source).toMatch(/\.then\([\s\S]*?\)[\s\S]*?\.catch\(/);
  });
});
