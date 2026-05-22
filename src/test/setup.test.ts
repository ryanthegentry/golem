import { describe, expect, it } from 'vitest';

describe('test harness setup', () => {
  it('installs EventSource before tests import Ark SDK users', () => {
    expect(globalThis.EventSource).toBeTypeOf('function');
  });
});
