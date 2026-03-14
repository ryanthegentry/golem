/**
 * Init command mainnet encryption tests — CRITICAL-002.
 *
 * --no-encrypt on mainnet must be a hard error, not a warning.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Init --no-encrypt mainnet block (CRITICAL-002)', () => {
  it('init.ts hard-blocks --no-encrypt on mainnet (exitWithError, not console.log)', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/init.ts'),
      'utf-8',
    );

    // Find the isMainnet && !shouldEncrypt block and check the next 3 lines
    const lines = source.split('\n');
    const checkLine = lines.findIndex(l => l.includes('isMainnet && !shouldEncrypt'));
    expect(checkLine).toBeGreaterThan(-1);
    const block = lines.slice(checkLine, checkLine + 4).join('\n');
    expect(block).toContain('exitWithError');
    expect(block).not.toContain('console.log');
  });

  it('--no-encrypt warning text is absent from init.ts on mainnet path', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/init.ts'),
      'utf-8',
    );

    // The old warning "Private key will be stored unencrypted on MAINNET" should not exist
    // in the pre-key-generation section (it's OK in the post-init info block)
    const lines = source.split('\n');
    const mainnetCheckLine = lines.findIndex(l => l.includes('isMainnet && !shouldEncrypt'));
    // The next few lines after that check should NOT be console.log warnings
    if (mainnetCheckLine >= 0) {
      const nextLines = lines.slice(mainnetCheckLine, mainnetCheckLine + 3).join('\n');
      expect(nextLines).toContain('exitWithError');
      expect(nextLines).not.toMatch(/console\.log.*WARNING/);
    }
  });
});
