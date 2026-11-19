import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-config-'));
});
afterEach(() => removeTempDir(home));
function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, 'config', ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOBSTAH_HOME: home },
    timeout: 15_000,
  });
}

it('previews and applies one upgrade, retaining the original and leaving a second apply unchanged', () => {
  const file = path.join(home, 'config.toml'),
    original = '[watch]\nmaxForksPerCycle=7\nrepairSettleSecs=42\n';
  fs.writeFileSync(file, original);
  const preview = run('upgrade', '--preview');
  expect(preview.status).toBe(0);
  expect(preview.stdout).toContain('schemaVersion = 2');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(fs.existsSync(`${file}.schema-1.bak`)).toBe(false);
  const applied = run('upgrade');
  expect(applied.status).toBe(0);
  const upgraded = fs.readFileSync(file, 'utf8');
  expect(upgraded).toContain('[watches]');
  expect(upgraded).toContain('[watchTypes.pr]');
  expect(fs.readFileSync(`${file}.schema-1.bak`, 'utf8')).toBe(original);
  expect(run('upgrade').status).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe(upgraded);
});

it('an invalid application configuration remains untouched even if its watch settings could upgrade', () => {
  const file = path.join(home, 'config.toml'),
    original = '[watch]\nmaxForksPerCycle=7\n[wait]\nbaseTimeoutSecs=-1\n';
  fs.writeFileSync(file, original);
  expect(run('upgrade').status).not.toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(fs.existsSync(`${file}.schema-1.bak`)).toBe(false);
});
