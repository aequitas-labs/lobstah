import { defineConfig } from 'vitest/config';

// Windows runners spawn git slowly and hold file handles after a process
// exits. Fewer workers keep git from starving the worker RPC channel, and the
// git-heavy suites get more time per test and per hook. Two workers is the
// fast run; CI retries a failed Windows run once with LOBSTAH_TEST_WORKERS=1,
// which keeps up when two still starve it (an "onTaskUpdate" timeout, or a
// CLI-spawning test past its limit).
const windows = process.platform === 'win32';
const windowsWorkers = Number(process.env.LOBSTAH_TEST_WORKERS) || 2;

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    environment: 'node',
    exclude: ['services/wharf/**', '**/node_modules/**'],
    // No test names or clears the tab of the terminal running the suite.
    env: { LOBSTAH_TERMINAL_TITLE: '0' },
    ...(windows && {
      maxWorkers: windowsWorkers,
      minWorkers: 1,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      teardownTimeout: 30_000,
    }),
  },
});
