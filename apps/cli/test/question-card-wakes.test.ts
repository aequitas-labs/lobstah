import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  answerDecision, answeredAt, appendStatus, askDecision, claimNext, complete, enqueue, ensureLayout,
  loadConfig, recordHelmPass, takeHelm, unhandled, withdrawDecision,
} from '@lobstah/core';
import { attentionNow, captureWaitBaseline, freshWakeEvents } from '@lobstah/supervisor';
import { armWatcher } from '../src/watchers.js';
import { openCardsAtStop } from '../src/open-cards.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { buildGlassSnapshot } from '../src/glass.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const id = '11111111-1111-4111-8111-111111111111';
const session = 'question-card-helm';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-question-card-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `remindSecs = 1\n[repos.r]\npath = '${home.replaceAll('\\', '/')}'\n[helm]\narmGraceSecs = 0\n`);
  enqueue({ id, repo: 'r', brief: 'Choose a version' });
  claimNext('work');
  fs.writeFileSync(path.join(home, 'active', id, 'runner.json'), JSON.stringify({ pid: 999001, startedAt: new Date().toISOString() }));
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

function card(dispatch: string | null = id) {
  return askDecision({ title: 'Which version?', dispatch: dispatch ?? undefined, grounds: 'home', repo: 'r', askedBy: 'helm', maxBytes: 1000 }).meta;
}
function run(...args: string[]) {
  const env = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', input: JSON.stringify({ session_id: session }), timeout: 10_000 });
}

it.each(['dispatch', 'link'] as const)('a %s card wakes once for a question, including an armed delivery; a new note still wakes', (via) => {
  const baseline = captureWaitBaseline();
  const linked = via === 'link' ? card(null) : undefined;
  appendStatus(id, 'work', 'needs-decision', 'Which version?', undefined,
    linked ? { link: `http://127.0.0.1:4949/#decision/${encodeURIComponent(linked.key)}` } : undefined);
  const framed = linked ?? card();
  expect(freshWakeEvents(baseline)).toMatchObject([{ id, entry: { note: 'Which version?' } }]);
  expect(attentionNow(true, 1, Date.now() + 86400_000)).toEqual([]);
  expect(freshWakeEvents(baseline)).toEqual([]);
  expect(buildTendReport().attention.filter(a => a.kind === 'question')).toEqual([]);
  expect(buildTendReport().openCards?.map(c => c.key)).toContain(framed.key);
  appendStatus(id, 'work', 'needs-decision', 'New information: version B is unavailable');
  expect(attentionNow()).toMatchObject([{ id, entry: { note: 'New information: version B is unavailable' } }]);
});

it('a card created after the first wake takes over reminders, and withdrawing it restores reminders', () => {
  appendStatus(id, 'work', 'needs-decision', 'Which version?');
  const now = Date.now();
  expect(attentionNow(true, 1000, now)).toHaveLength(1);
  const framed = card();
  expect(attentionNow(false, 1000, now + 2000)).toEqual([]);
  withdrawDecision(framed.key);
  expect(attentionNow(false, 1000, now + 2000)).toHaveLength(1);
  expect(buildTendReport().openCards).toBeUndefined();
});

it.each(['done', 'failed'] as const)('keeps a card visible through paused, working and %s, and still accepts its answer', (terminal) => {
  appendStatus(id, 'work', 'needs-decision', 'Which version?');
  const framed = card();
  for (const verb of ['paused', 'working', terminal] as const) {
    appendStatus(id, 'work', verb, 'Moved on while the card waits');
    if (verb === terminal) complete(id, 'work');
    expect(buildTendReport().openCards?.map(c => c.key)).toContain(framed.key);
    expect(buildGlassSnapshot().decisions.map(c => c.key)).toContain(framed.key);
  }
  answerDecision({ key: framed.key, text: 'Use version A', by: 'glass', maxBytes: 1000 });
  expect(unhandled(id, 'work')).toEqual([]); // A finished dispatch is not resumed by its retained card.
  expect(buildTendReport().openCards).toBeUndefined();
  expect(buildGlassSnapshot().decisions).toEqual([]);
});

it('withdrawing a card after completion removes it from both tend and glass', () => {
  appendStatus(id, 'work', 'needs-decision', 'Which version?');
  const framed = card();
  appendStatus(id, 'work', 'done', 'Finished'); complete(id, 'work');
  withdrawDecision(framed.key);
  expect(buildTendReport().openCards).toBeUndefined();
  expect(buildGlassSnapshot().decisions).toEqual([]);
});

it('re-arms man wait quietly and shows the human wait at Stop without blocking', () => {
  recordHelmPass('home', loadConfig().helm);
  takeHelm({ sessionId: session, grounds: { name: 'home', repos: ['r'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
  appendStatus(id, 'work', 'needs-decision', 'Which version?');
  const framed = card();
  const first = run('man', 'wait', '--session', session, '--timeout', '0.01');
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain('Which version?');
  for (let i = 0; i < 2; i++) {
    const quiet = run('man', 'wait', '--session', session, '--timeout', '0.01');
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(3);
    expect(quiet.stdout).toContain('timeout: true');
  }
  const waiting = `waiting on human · card ${framed.key}`;
  expect(renderTend(buildTendReport())).toContain(waiting);
  const watcher = armWatcher(session, 'man');
  try {
    const stopped = run('man', 'haul');
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ systemMessage: expect.stringContaining(waiting) });
    expect(JSON.parse(stopped.stdout).decision).toBeUndefined();
  } finally { watcher.stop(); }
  // The hook's own park also returns a nonblocking reminder on a quiet deadline.
  const parked = run('man', 'haul', '--park', '--timeout', '0.01');
  expect(parked.status, parked.stderr).toBe(0);
  expect(JSON.parse(parked.stdout)).toMatchObject({ systemMessage: expect.stringContaining(waiting) });
  expect(JSON.parse(parked.stdout).decision).toBeUndefined();
  answerDecision({ key: framed.key, text: 'Use A', by: 'glass', maxBytes: 1000 });
  const answer = run('man', 'wait', '--session', session, '--timeout', '0.01');
  expect(answer.status, answer.stderr).toBe(0);
  expect(answer.stdout).toContain('event: decision-answer');
});


it('several cards on one question stay open without adding Stop blockers or duplicate wait lines', () => {
  appendStatus(id, 'work', 'needs-decision', 'Which version?');
  const first = card();
  const second = card();
  const helm = takeHelm({ sessionId: session, grounds: { name: 'home', repos: ['r'] }, ttlMs: 60_000 });
  if (!('ok' in helm)) throw new Error('Expected a fresh helm');
  attentionNow();
  expect(openCardsAtStop(helm.ok, loadConfig(), false, Date.now() + 86400_000)).toBe('');
  const report = buildTendReport();
  expect(report.openCards?.map(c => c.key).sort()).toEqual([first.key, second.key].sort());
  expect(renderTend(report).match(/waiting on human · card/g)).toHaveLength(1);
});


it('answering a retained card never answers a newer worker question', () => {
  appendStatus(id, 'work', 'needs-decision', 'Which version?');
  const framed = card();
  const newer = appendStatus(id, 'work', 'needs-decision', 'Can I change the schema too?');
  answerDecision({ key: framed.key, text: 'Use version A', by: 'glass', maxBytes: 1000 });
  expect(unhandled(id, 'work')).toEqual([]);
  expect(answeredAt(id, 'work', newer.at)).toBeUndefined();
  expect(attentionNow()).toMatchObject([{ id, entry: { note: newer.note } }]);
});
