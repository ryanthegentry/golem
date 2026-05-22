import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // Silence stderr from tests that exercise error paths; failing tests still log.
    silent: 'passed-only',
  },
});
