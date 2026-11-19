import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  addWatch,
  builtinWatchRegistry,
  ensureLayout,
  restoreLegacyWatch,
  updateWatch,
  normalizeUmeFeedback,
  WatchRuntime,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-native-ume-'));
  vi.stubEnv('LOBSTAH_HOME', home);
  ensureLayout();
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTempDir(home);
});
const artifact = 'review-7',
  project = 'recorded-project',
  org = 'recorded-org';
const feedback = (seq: number) => ({ feedbackCount: 1, batches: [{ cursor: seq, entries: [{ seq, kind: 'comments.sent' }] }] });
const owner = { kind: 'helm' as const, grounds: 'home' };

it('reads in the recorded project when the ambient project differs and supplies that project to every role', () => {
  vi.stubEnv('UME_PROJECT', 'ambient-project');
  const read = vi.fn(() => feedback(8));
  const runtime = new WatchRuntime(builtinWatchRegistry({ ume: { read } }));
  runtime.register('ume', artifact, { project, org, cwd: home, cursor: '7' }, owner);
  const snapshot = runtime.checkSync(`ume:${artifact}`, { everySecs: 0 })!;
  expect(read.mock.calls).toEqual([[['feedback', artifact, '--peek', '--since', '7', '--json'], home, project]]);
  expect(snapshot.state).toEqual({ project, org });
  expect(snapshot.presentation.worker.read?.environment).toMatchObject({ UME_PROJECT: project });
  expect(snapshot.presentation.helm.read?.environment).toMatchObject({ UME_PROJECT: project });
});

it('checkpoints recovered context and preserves it on restart despite stale registration options', () => {
  const read = vi.fn((args: string[], _cwd?: string, selected?: string) => {
    if (args[0] === 'projects') return { projects: [{ project, org }] };
    if (selected !== project) throw new Error('ume: no_such_artifact');
    return feedback(8);
  });
  const runtime = new WatchRuntime(builtinWatchRegistry({ ume: { read } }));
  runtime.register('ume', artifact, { project: 'old-project', org: 'old-org', cursor: '7' }, owner);
  expect(runtime.checkSync(`ume:${artifact}`, { everySecs: 0 })!.state).toEqual({ project, org });
  read.mockClear();
  const restarted = new WatchRuntime(builtinWatchRegistry({ ume: { read } }));
  restarted.register('ume', artifact, { project: 'old-project', org: 'old-org' }, owner);
  const snapshot = restarted.checkSync(`ume:${artifact}`, { everySecs: 0 })!;
  expect(read.mock.calls).toEqual([[['feedback', artifact, '--peek', '--since', '8', '--json'], undefined, project]]);
  expect(snapshot.events.map((event) => event.id)).toEqual(['8']);
});

it('normalizes repeated sequences once and rejects malformed provider checkpoints', () => {
  const state = { project, org },
    now = new Date().toISOString();
  const normalized = normalizeUmeFeedback(
    artifact,
    '7',
    { feedbackCount: 3, batches: [feedback(8).batches[0], feedback(8).batches[0], feedback(9).batches[0]] },
    state,
    now,
  );
  expect(normalized.events.map((event) => event.id)).toEqual(['8', '9']);
  expect(normalized.cursor).toBe('9');
  expect(() => normalizeUmeFeedback(artifact, '7', { feedbackCount: 1, batches: [{ cursor: '8', entries: [] }] }, state, now)).toThrow(
    /invalid feedback cursor/,
  );
});

it('imports the check-ume transport without resetting its cursor or pending continuation receipt', () => {
  const key = `ume:${artifact}`,
    runtime = new WatchRuntime(builtinWatchRegistry());
  let watch = addWatch(key, 'echo {}', { cursor: '4', context: { cwd: home, env: { UME_PROJECT: project }, org } });
  restoreLegacyWatch(watch, runtime);
  runtime.journal.update(key, (snapshot) => {
    snapshot!.events.push({ id: '5', kind: 'comments.sent', summary: 'pending feedback', at: new Date().toISOString(), data: { seq: 5 } });
    snapshot!.deliveries.push({ id: 'original-receipt', eventIds: ['5'], status: 'pending', continuationId: 'reserved-work' });
    return { snapshot, result: undefined };
  });
  const file = fs.readdirSync(runtime.journal.directory).find((name) => name.endsWith('.json'))!;
  const oldBytes = fs.readFileSync(path.join(runtime.journal.directory, file), 'utf8');
  watch = { ...watch, check: `lobstah watch check-ume ${artifact} --cursor {cursor}` };
  updateWatch(watch);
  restoreLegacyWatch(watch, runtime);
  expect(runtime.journal.read(key)).toMatchObject({
    type: { id: 'ume' },
    cursor: '4',
    state: { project, org },
    deliveries: [{ id: 'original-receipt', eventIds: ['5'], continuationId: 'reserved-work', status: 'pending' }],
  });
  const backup = fs.readdirSync(runtime.journal.directory).find((name) => name.endsWith('.bak'))!;
  expect(fs.readFileSync(path.join(runtime.journal.directory, backup), 'utf8')).toBe(oldBytes);
});
