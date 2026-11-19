import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { lobstahHome, ensureLayout } from '../src/paths.js';
import { appendStatus } from '../src/status.js';
import { loadConfig } from '../src/config.js';

it('a late runner write after fixture teardown stays in a disposable profile', async () => {
  const actualOs = await vi.importActual<typeof import('node:os')>('node:os');
  delete process.env.LOBSTAH_HOME;
  const fallback = lobstahHome();
  expect(fallback).toBe(path.join(os.homedir(), '.lobstah'));
  expect(fallback).not.toBe(path.join(actualOs.homedir(), '.lobstah'));
  expect(fallback.startsWith(os.tmpdir())).toBe(true);
  ensureLayout();
  appendStatus('origin', 'work', 'failed', 'isolated late test result');
  expect(fs.readFileSync(path.join(fallback, 'state', 'origin.status'), 'utf8')).toContain('isolated late test result');
});

it('ordinary reads cannot apply an implicit configuration upgrade', () => {
  ensureLayout();
  const file = path.join(lobstahHome(), 'config.toml'),
    original = '[watch]\nmaxForksPerCycle=3\n';
  fs.writeFileSync(file, original);
  loadConfig();
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(fs.existsSync(`${file}.schema-1.bak`)).toBe(false);
});
