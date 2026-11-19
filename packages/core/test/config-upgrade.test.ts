import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { loadConfig } from '../src/config.js';
import { prepareConfigurationUpgrade } from '../src/config-upgrade.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-config-upgrade-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

it('upgrades once, preserves configured behavior and unrelated settings, and backs up the original', () => {
  const file = path.join(home, 'config.toml');
  const original =
    'attentionKinds=["pr:checks"]\nreadySettleSecs=90\n[watch]\nmaxForksPerCycle=5\nautoRepair=false\nrepairCooldownSecs=12\n[repos.app]\npath="/projects/app"\ntrunk="main"\n';
  fs.writeFileSync(file, original);
  const config = loadConfig({ upgrade: true });
  expect(config.watch).toMatchObject({ maxForksPerCycle: 5, autoRepair: false, repairCooldownSecs: 12 });
  expect(config.attentionKinds).toEqual(['pr:checks']);
  expect(config.readySettleSecs).toBe(90);
  const upgraded = fs.readFileSync(file, 'utf8');
  expect(parse(upgraded)).toMatchObject({
    schemaVersion: 2,
    watches: { maxForksPerCycle: 5, attention: { enabledKinds: ['pr:checks'] } },
    watchTypes: { pr: { autoRepair: false, repairCooldownSecs: 12, readySettleSecs: 90 } },
    repos: { app: { path: '/projects/app', trunk: 'main' } },
  });
  expect(parse(upgraded).watch).toBeUndefined();
  expect(fs.readFileSync(`${file}.schema-1.bak`, 'utf8')).toBe(original);
  loadConfig({ upgrade: true });
  expect(fs.readFileSync(file, 'utf8')).toBe(upgraded);
});

it('preview validates the complete configuration without writing or making a backup', () => {
  const file = path.join(home, 'config.toml'),
    original = '[watch]\nmaxForksPerCycle=8\n';
  fs.writeFileSync(file, original);
  expect(loadConfig({ upgrade: false }).watch.maxForksPerCycle).toBe(8);
  expect(prepareConfigurationUpgrade(original).raw.schemaVersion).toBe(2);
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(fs.existsSync(`${file}.schema-1.bak`)).toBe(false);
});

it('invalid unrelated settings leave the original intact before an upgrade can publish', () => {
  const file = path.join(home, 'config.toml'),
    original = '[watch]\nmaxForksPerCycle=8\n[soak]\nidleStowMins=-1\n';
  fs.writeFileSync(file, original);
  expect(() => loadConfig({ upgrade: true })).toThrow('idleStowMins');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(fs.existsSync(`${file}.schema-1.bak`)).toBe(false);
});

it.each([
  ['[watch]\nunknown=true', 'unknown'],
  ['schemaVersion=2\n[watch]\nmaxForksPerCycle=3', 'mixes'],
  ['[watches]\nmaxForksPerCycle=3', 'mixes'],
  ['schemaVersion=99', 'Unsupported'],
  ['schemaVersion=2\n[watches]\nmaxForksPerCycle=-1', 'non-negative'],
])('rejects ambiguous or unmappable input without modifying it: %s', (original, error) => {
  const file = path.join(home, 'config.toml');
  fs.writeFileSync(file, original);
  expect(() => loadConfig({ upgrade: true })).toThrow(error);
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
});

it('retains comments and exact unrelated table text during a watch upgrade', () => {
  const file = path.join(home, 'config.toml');
  fs.writeFileSync(
    file,
    '# personal config\nattentionKinds=["question"]\n[repos.web]\npath="/w" # retain path comment\n[reviews]\n# retain token reference\ntokenEnv="REVIEW_TOKEN"\n',
  );
  loadConfig({ upgrade: true });
  expect(fs.readFileSync(file, 'utf8')).toContain('# personal config');
  expect(fs.readFileSync(file, 'utf8')).toContain('path="/w" # retain path comment');
  expect(fs.readFileSync(file, 'utf8')).toContain('# retain token reference');
});

it('read-only configuration views never publish an upgrade', () => {
  const file = path.join(home, 'config.toml'),
    original = '[watch]\nmaxForksPerCycle=7\n';
  fs.writeFileSync(file, original);
  expect(loadConfig().watch.maxForksPerCycle).toBe(7);
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(fs.existsSync(`${file}.schema-1.bak`)).toBe(false);
});
