import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      // Test-only fixtures, not credentials for any running/deployed service.
      HELM_PAT_HASHES: '{"a":["d3fb8ec042f408a3527efbca35f09c220491efb63b231697f4e6f2ed994748d1"]}',
      TOKEN_SECRET: 'test-only-token-signing-secret-not-for-deployment',
    } } })],
  test: { include: ['test/**/*.test.ts'] },
});
