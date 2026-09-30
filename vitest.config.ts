import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // No test names or clears the tab of the terminal running the suite.
    env: { LOBSTAH_TERMINAL_TITLE: '0' },
  },
});
