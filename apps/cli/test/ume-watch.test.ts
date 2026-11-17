import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  addWatch, appendStatus, claimBait, enqueue, ensureLayout, listWatches, readTrap, readTurnOwner,
  signOnTrap, unhandled, type TrapRegistration,
} from '@lobstah/core';
import { addUmeWatch, registerUmeReview, runUmeCheck, clearFinishedUmeWatches } from '../src/ume-watch.js';
import { createTurnWaits, readTurnWaitRecords } from '../src/turn-waits.js';
import { createCodexTrapWatch } from '../src/codex-trap-watch.js';
import { soakPark } from '../src/trap-park.js';
import { turnWaitsRow } from '../src/turn-doctor.js';
import { buildTendReport } from '../src/tend.js';
import { listenerRow } from '../src/hook-readiness.js';
import { watchLoop } from '../../pick/src/loops/watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let trap: TrapRegistration;
const OWNER = '44444444-4444-4444-8444-444444444444';
const ARTIFACT = '47dd003a-1e5';
const LINK = `https://app.ume.so/a/${ARTIFACT}`;
const PROJECT = 'vr95mce908';
const batch = (seq: number, kind = 'comments.sent') => ({ feedbackCount: 1, batches: [{ cursor: seq, entries: [{ seq, kind }] }] });
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ume-watch-'));
  vi.stubEnv('LOBSTAH_HOME', path.join(home, 'lobstah'));
  vi.stubEnv('AGENT_TURN_HOME', path.join(home, 'turns'));
  ensureLayout();
  const signed = signOnTrap({ worktree: home, cwd: home, repo: 'r', harness: 'codex', sessionId: 'thread', ttlMs: 600_000,
    window: { tmuxPane: '%7', tmuxSocket: '/tmp/tmux-501/lobstah' } });
  if (!('ok' in signed)) throw new Error('held');
  enqueue({ id: OWNER, repo: 'r', for: `wt:${signed.ok.trapId}`, brief: 'write the plan' });
  claimBait(signed.ok);
  trap = readTrap(signed.ok.trapId)!;
  appendStatus(OWNER, 'work', 'paused', 'waiting on review', undefined, { waitingOn: 'review', link: LINK }, true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); removeTempDir(home); });
function register() {
  return registerUmeReview(OWNER, 'work', { at: new Date().toISOString(), verb: 'paused', link: LINK }, { UME_PROJECT: PROJECT })!;
}
/** Exercise the real preset adapter as a child of the generic watch loop, with fixture feedback. */
function source() {
  const watch = register();
  const script = path.join(home, 'source.cjs');
  const module = pathToFileURL(path.resolve('apps/cli/dist/ume-watch.js')).href;
  const fixture = path.join(home, 'feedback.json');
  fs.writeFileSync(script, `(async () => {
    const fs = require('node:fs');
    const { runUmeCheck } = await import(${JSON.stringify(module)});
    console.log(runUmeCheck(${JSON.stringify(ARTIFACT)}, process.argv[2], (args, cwd, project) => {
      fs.writeFileSync(${JSON.stringify(path.join(home, 'called.json'))}, JSON.stringify({args,cwd,project,env:process.env.UME_PROJECT}));
      return JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
    }));
  })().catch(e => { console.error(e); process.exitCode=1; });`);
  addWatch(watch.key, `"${process.execPath}" "${script}" {cursor}`, { everySecs: 0 });
  return (value: unknown) => fs.writeFileSync(fixture, JSON.stringify(value));
}

it('registers the normal ume key with project context and a shipped check command', () => {
  const w = register();
  expect(w.key).toBe(`ume:${ARTIFACT}`);
  expect(w.owner).toBe(`dispatch:${OWNER}`);
  expect(w.context).toMatchObject({ cwd: home, env: { UME_PROJECT: PROJECT } });
  expect(w.check).toContain(`watch check-ume ${ARTIFACT} --cursor {cursor}`);
});

it('automatic registration preserves an existing watch, like PR registration', () => {
  addWatch(`ume:${ARTIFACT}`, 'custom check', { owner: 'man', cursor: '7' });
  expect(registerUmeReview(OWNER, 'work', { at: new Date().toISOString(), verb: 'paused', link: LINK })).toBeUndefined();
  expect(listWatches()[0]).toMatchObject({ check: 'custom check', owner: 'man', cursor: '7' });
});

it('pick polls the preset with its context and wakes hookless Codex once for each new batch', async () => {
  const write = source();
  write(batch(1));
  const tmux = vi.fn(async (args: string[]) => args[0] === 'capture-pane' ? '› Ask Codex to do anything\n? for shortcuts\n' : '');
  await watchLoop(45, () => {});
  expect(JSON.parse(fs.readFileSync(path.join(home, 'called.json'), 'utf8'))).toMatchObject({
    args: ['feedback', ARTIFACT, '--peek', '--since', '0', '--json'], project: PROJECT, env: PROJECT,
  });
  await createCodexTrapWatch({ tmux })(Date.now(), () => {});
  expect(tmux.mock.calls.some(c => c[0][0] === 'send-keys')).toBe(true);
  expect(unhandled(OWNER, 'work')[0]?.text).toContain(`UME_PROJECT=${PROJECT}`);
  tmux.mockClear();
  await watchLoop(45, () => {});
  await createCodexTrapWatch({ tmux })(Date.now(), () => {});
  expect(unhandled(OWNER, 'work')).toHaveLength(1);
  expect(tmux).not.toHaveBeenCalled();
  write(batch(2, 'thread.resolved'));
  await watchLoop(45, () => {});
  expect(unhandled(OWNER, 'work')).toHaveLength(2);
});

it('a quiet poll neither wakes the owner nor consumes the ume read cursor', async () => {
  fs.mkdirSync(path.join(home, '.ume'));
  const local = JSON.stringify({ cursors: { [ARTIFACT]: 5 } });
  fs.writeFileSync(path.join(home, '.ume', 'next.json'), local);
  source()({ feedbackCount: 0 });
  await watchLoop(45, () => {});
  expect(unhandled(OWNER, 'work')).toHaveLength(0);
  expect(fs.readFileSync(path.join(home, '.ume', 'next.json'), 'utf8')).toBe(local);
  expect(listWatches()[0].cursor).toBe('5');
});

it('the preset recovers a legacy project across organizations and stores it on the watch', () => {
  addUmeWatch(ARTIFACT, { forId: OWNER, cwd: home, project: 'wrong' });
  const read = vi.fn((args: string[], _cwd?: string, project?: string) => {
    if (args[0] === 'projects') return { projects: [{ project: PROJECT, org: 'base-research' }] };
    if (project !== PROJECT) throw new Error('ume: no_such_artifact');
    return batch(6, 'artifact.approved');
  });
  expect(JSON.parse(runUmeCheck(ARTIFACT, '5', read)).events).toHaveLength(1);
  expect(listWatches()[0].context).toMatchObject({ env: { UME_PROJECT: PROJECT }, org: 'base-research' });
  read.mockClear();
  runUmeCheck(ARTIFACT, '6', read);
  expect(read.mock.calls.map(c => c[2])).toEqual([PROJECT]);
});

it.each(['codex', 'claude'])('generic event delivery reaches a %s park listener', async harness => {
  signOnTrap({ ...trap, harness, ttlMs: 600_000 });
  source()(batch(1));
  await watchLoop(45, () => {});
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await soakPark(trap.trapId, '0', false);
  expect(output.mock.calls[0][0]).toContain(`ume feedback ${ARTIFACT}`);
});

it('approval uses normal event delivery, and done clears the watch without a continuation', async () => {
  source()(batch(1, 'artifact.approved'));
  await watchLoop(45, () => {});
  expect(unhandled(OWNER, 'work')[0]?.text).toContain('artifact.approved');
  expect(listWatches()[0].lastFollowUpId).toBeUndefined();
  appendStatus(OWNER, 'work', 'done', 'approved; finished');
  clearFinishedUmeWatches();
  expect(listWatches()).toHaveLength(0);
});

it('a ume park registers a normal watch instead of launching a turn-wait poller', () => {
  const old = new Set(process.listeners('exit'));
  fs.writeFileSync(path.join(readTurnOwner(trap.sessionId)!.waits, 'ume.json'), JSON.stringify({
    from: 'ume', read: `ume feedback ${ARTIFACT}`, wait: `ume await ${ARTIFACT} --turn-line --since {cursor}`, cwd: home, cursor: '5',
  }));
  const start = vi.fn(() => { throw new Error('unexpected turn wait poller'); });
  try {
    createTurnWaits(start).pass(Date.now(), () => {});
    expect(start).not.toHaveBeenCalled();
    expect(readTurnWaitRecords()[0].watchKey).toBe(`ume:${ARTIFACT}`);
    expect(listWatches()[0].cursor).toBe('5');
    expect(turnWaitsRow({ home, env: {} }).detail).toContain('watched');
    expect(buildTendReport().watches[0]).toMatchObject({ key: `ume:${ARTIFACT}`, owner: `dispatch:${OWNER}` });
  } finally {
    for (const listener of process.listeners('exit')) if (!old.has(listener)) process.removeListener('exit', listener);
  }
});

it('doctor shows a paused catch without a park listener', () => {
  expect(listenerRow(Date.now() + 11_000)).toMatchObject({ status: 'warn' });
  expect(listenerRow(Date.now() + 11_000).detail).toContain('paused without a park listener');
});

it('uses normal watch failure reporting and recovery in tend', async () => {
  const write = source();
  write({ invalid: true });
  await watchLoop(45, () => {});
  expect(unhandled(OWNER, 'work')).toHaveLength(0);
  expect(listWatches()[0].failures).toBe(1);
  expect(buildTendReport().watches[0].error).toContain('invalid feedback');
  write(batch(1));
  await watchLoop(45, () => {});
  expect(listWatches()[0].lastError).toBeUndefined();
  expect(unhandled(OWNER, 'work')).toHaveLength(1);
});
