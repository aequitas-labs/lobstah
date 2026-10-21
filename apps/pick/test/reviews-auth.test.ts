import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { ensureLayout } from '@lobstah/core';
import { loadPickupConfig } from '../src/config.js';
import { removeTempDir } from '../../../test/temp-dir.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execSync: vi.fn(() => 'fixture-token\n'),
  spawnSync: vi.fn(() => ({ status: 0, stdout: 'chris\n' })),
}));
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-auth-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\n');
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});
it('derives identity and token through existing gh auth without a pickup table', () => {
  const config = loadPickupConfig();
  expect(config.github).toEqual([]);
  expect(config.reviews?.identity).toBe('chris');
  expect(config.reviews?.token()).toBe('fixture-token');
  expect(execSync).toHaveBeenCalledTimes(1);
  expect(execSync).toHaveBeenCalledWith('gh auth token', expect.anything());
  expect(spawnSync).toHaveBeenCalledWith('gh', ['api', 'user', '--jq', '.login'], expect.anything());
});
