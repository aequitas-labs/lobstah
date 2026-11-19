import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { stringify } from 'smol-toml';
import { WatchJournal } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../packages/watch-types/test/fixtures/process-watch.mjs', import.meta.url));
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-plugin-')); });
afterEach(() => removeTempDir(home));

it('registers a configured adapter from real CLI flags with a stable trap owner and typed per-watch options', () => {
  const history = path.join(home, 'history with spaces.json');
  fs.writeFileSync(history, JSON.stringify({ cursor: 0, events: [] }));
  fs.writeFileSync(path.join(home, 'config.toml'), stringify({ schemaVersion: 2, watchTypes: { fixture: { module: 'process', command: [process.execPath, fixture], version: '1.0.0' } } }));
  const result = spawnSync(process.execPath, [cli, 'watch', 'add', 'fixture:cli', '--type', 'fixture', '--options', JSON.stringify({ history }), '--owner', 'wt:stable-owner'], { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home }, timeout: 15000 });
  expect({ status: result.status, error: result.error, stderr: result.stderr }).toMatchObject({ status: 0, error: undefined, stderr: '' });
  expect(result.stdout).toContain('registered: true');
  const stored = new WatchJournal(path.join(home, 'watch-journal')).read('fixture:cli');
  expect(stored).toMatchObject({ options: { history }, owner: { kind: 'trap', trapId: 'stable-owner' }, type: { id: 'fixture', installation: { kind: 'process' } } });
  const journal = new WatchJournal(path.join(home, 'watch-journal'));
  journal.update('fixture:cli', (snapshot) => {
    snapshot!.events.push({ id: 'provider-1', kind: 'fixture:approval', summary: 'Read fixture feedback', at: new Date().toISOString(), data: null });
    snapshot!.deliveries.push({ id: 'delivery-1', eventIds: ['provider-1'], status: 'pending' });
    return { snapshot, result: undefined };
  });
  const inbox = spawnSync(process.execPath, [cli, 'watch', 'inbox', '--owner', 'wt:stable-owner'], { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home }, timeout: 15000 });
  expect(inbox.status).toBe(0);
  expect(inbox.stdout).toContain('Read fixture feedback');
  expect(journal.read('fixture:cli')!.deliveries[0]!.status).toBe('delivered');
});
