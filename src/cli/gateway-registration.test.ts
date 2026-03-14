/**
 * Gateway 402index integration tests — source inspection.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Gateway 402index integration', () => {
  it('gateway.ts imports registerWithIndex', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/gateway.ts'),
      'utf-8',
    );
    expect(source).toContain('registerWithIndex');
    expect(source).toContain('402index');
  });

  it('gateway-config.ts has publicUrl and autoRegister fields', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'gateway-config.ts'),
      'utf-8',
    );
    expect(source).toContain('publicUrl');
    expect(source).toContain('autoRegister');
  });

  it('gateway-init.ts mentions publicUrl for registration', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'commands/gateway-init.ts'),
      'utf-8',
    );
    expect(source).toContain('publicUrl');
    expect(source).toContain('402index');
  });
});
