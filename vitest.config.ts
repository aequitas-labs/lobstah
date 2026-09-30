import { defineConfig } from 'vitest/config';

// Windows runners spawn git slowly and hold file handles after a process
// exits. Fewer workers keep git from starving the worker RPC channel, and the
// git-heavy suites get more time per test and per hook.
const windows = process.platform === 'win32';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // No test names or clears the tab of the terminal running the suite.
    env: { LOBSTAH_TERMINAL_TITLE: '0' },
    ...(windows && {
      maxWorkers: 2,
      minWorkers: 1,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      teardownTimeout: 30_000,
    }),
  },
});
