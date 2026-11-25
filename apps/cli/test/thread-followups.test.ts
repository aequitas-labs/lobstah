import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, startHelmThread, sayThread, readThread, noticeStaleThreads, staleThreadResolveCommand, listNotices, unseenNotices, postNotice, takeHelm, recordHelmPass, loadConfig, enqueue, claimNext, appendStatus, complete, noteThread, parsePrRef, prEvidence, upsertPr, threadTrackedItems } from '@lobstah/core';
import type { GhPrView } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const session = 'thread-followup-helm';
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LOBSTAH_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-thread-followups-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[helm]\narmGraceSecs = 0\n[repos.web]\npath = '${home.replaceAll('\\', '/')}'\n[grounds.alpha]\nrepos = ['web']\n[grounds.beta]\nrepos = []\n`);
  recordHelmPass('alpha', loadConfig().helm);
  takeHelm({ sessionId: session, grounds: { name: 'alpha', repos: ['web'] }, ttlMs: 60_000 });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = previousHome;
  removeTempDir(home);
});

/** Run the real CLI with this test's isolated store and helm identity. */
function run(args: string[], input?: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('CODEX') && key !== 'LOBSTAH_GROUNDS'));
  const result = spawnSync(process.execPath, [cli, 'man', ...args, ...(args[0] === 'haul' ? [] : ['--session', session])], { cwd: home, env, input, encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result.stdout;
}

/** A conversation quiet for 25 hours with no linked work. */
function staleThread(grounds: string = 'alpha'): string {
  return startHelmThread({ grounds, title: 'Outreach reshape', now: new Date(Date.now() - 25 * 60 * 60 * 1000) }).id;
}

/** Deliver through a wake carrier, extracting a Stop block's JSON envelope. */
function wake(surface: string, peek: boolean = false): string {
  if (surface === 'stop') {
    const lines = run(['haul'], JSON.stringify({ session_id: session })).trim().split('\n').filter(Boolean);
    return lines.map((line) => (JSON.parse(line) as { reason?: string }).reason ?? '').join('\n');
  }
  return run(surface === 'wait' ? ['wait', ...(peek ? ['--peek'] : ['--timeout', '0'])] : ['report']);
}

it.each(['wait', 'report', 'stop'])('delivers one stale-thread notice through %s with its age and exact close command', (surface) => {
  const id = staleThread();
  const output = wake(surface);
  expect(output).toContain('thread-stale');
  expect(output).toContain(id);
  expect(output).toContain('Outreach reshape');
  expect(output).toContain('quiet 25.0h');
  expect(output).toContain('next:');
  // toon quotes fields that contain quotes; the Stop hook has already been decoded above.
  expect(output.replaceAll('\\"', '"')).toContain(staleThreadResolveCommand(id));
  for (const nextSurface of ['wait', 'report', 'stop']) expect(wake(nextSurface, true)).not.toContain('thread-stale');
  expect(listNotices().filter((notice) => notice.kind === 'thread-stale')).toHaveLength(1);
});

it('keeps report peeks non-consuming, including JSON output, and consumes only stale notices', () => {
  const id = staleThread();
  postNotice({ kind: 'message-bounced', text: 'Unrelated notice', grounds: 'alpha' });
  for (let n = 0; n < 2; n++) {
    const peek = JSON.parse(run(['report', '--peek', '--json']));
    expect(peek.staleThreads).toMatchObject([{ notice: 'thread-stale', thread: id, next: expect.stringContaining(staleThreadResolveCommand(id)) }]);
  }
  expect(wake('report')).toContain('thread-stale');
  expect(unseenNotices(false)).toMatchObject([{ kind: 'message-bounced', text: 'Unrelated notice' }]);
  expect(wake('report')).not.toContain('thread-stale');
});

it('does not deliver another grounds\' stale notice', () => {
  const own = staleThread();
  const other = staleThread('beta');
  noticeStaleThreads();
  const output = wake('report');
  expect(output).toContain(own);
  expect(output).not.toContain(other);
  expect(unseenNotices(false).filter((notice) => notice.kind === 'thread-stale')).toMatchObject([{ refId: other }]);
});

it('does not deliver a stale notice if the conversation resumed before its wake', () => {
  const id = staleThread();
  noticeStaleThreads();
  sayThread(id, { text: 'The approach changed' });
  expect(wake('wait', true)).not.toContain('thread-stale');
  expect(wake('report')).not.toContain('thread-stale');
});

it('lets the suggested resolve command close the stale thread', () => {
  const id = staleThread();
  wake('wait');
  const resolved = JSON.parse(run(['resolve', id, '--outcome', 'dropped', '--note', 'No new message for 24 hours']));
  expect(resolved).toMatchObject({ state: 'resolved', outcome: { kind: 'dropped' } });
  expect(wake('wait', true)).not.toContain('thread-stale');
});

it('accepts --superseded-by and keeps the failed reshape from reopening a thread after its replacement merged', () => {
  const thread = startHelmThread({ grounds: 'alpha', title: 'Outreach reshape' });
  enqueue({ id: 'old-reshape', repo: 'web', brief: 'Outreach reshape' }); claimNext('work');
  appendStatus('old-reshape', 'work', 'failed', 'Replaced by PR #3114'); complete('old-reshape', 'work');
  noteThread(thread.id, { link: 'dispatched:old-reshape' });
  const replacement = parsePrRef('o/r#3114')!;
  upsertPr(prEvidence(replacement, { title: 'Replace the outreach reshape', state: 'MERGED', isDraft: false, headRefOid: 'abc' } as GhPrView, new Date().toISOString()));
  const resolved = JSON.parse(run(['resolve', thread.id, '--outcome', 'answered', '--note', 'Replaced by PR #3114', '--superseded-by', `pr:${replacement.url}`]));
  expect(resolved).toMatchObject({ state: 'resolved', supersessions: [{ dispatch: 'old-reshape', replacement: `pr:${replacement.url}` }] });
  expect(threadTrackedItems(readThread(thread.id)!)).toMatchObject([{ kind: 'dispatch', status: 'superseded', state: 'done' }, { kind: 'pr', state: 'done' }]);
  wake('wait', true);
  expect(readThread(thread.id)?.state).toBe('resolved');
});
