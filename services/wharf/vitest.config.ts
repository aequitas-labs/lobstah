import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      // Test-only fixtures, not credentials for any running/deployed service.
      GLASS_ORIGIN: 'https://glass.test', API_ORIGIN: 'https://state.test', GITHUB_CLIENT_ID: 'stub-client',
      GITHUB_ALLOWLIST: '["123","456"]', AUTH_SECRET: 'test-only-auth-secret-not-a-real-credential-32bytes', GITHUB_CLIENT_SECRET: 'stub-secret',
      TOKEN_SECRET: 'test-only-token-signing-secret-not-for-deployment',
    } } })],
  test: {
    include: ['test/**/*.test.ts'],
    // Native D1/DO fixtures are deliberately shared. Migration/deletion tests
    // must finish before another file resets or reads those same test records.
    fileParallelism: false,
    ...(process.platform === 'win32' && { testTimeout: 30_000, hookTimeout: 30_000 }),
  },
});
