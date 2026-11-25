import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ackDecision, answerDecision, askDecision, ensureLayout, listDecisions, noteThread, startHelmThread, takeHelm, withdrawDecision } from '@lobstah/core';
import { reusedTitleCard } from '../src/decisions.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const session = 'discussion-helm';
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LOBSTAH_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-decision-discussions-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[helm]\narmGraceSecs = 0\n[repos.web]\npath = '${home.replaceAll('\\', '/')}'\n[grounds.alpha]\nrepos = ['web']\n[grounds.beta]\nrepos = []\n`);
  takeHelm({ sessionId: session, grounds: { name: 'alpha', repos: ['web'] }, ttlMs: 60_000 });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = previousHome;
  removeTempDir(home);
});

/** Invoke a helm command against this test's isolated store. */
function run(args: string[], input?: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('CODEX') && key !== 'LOBSTAH_GROUNDS'));
  const result = spawnSync(process.execPath, [cli, 'man', ...args, ...(args[0] === 'haul' ? [] : ['--session', session])], { env, input, encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result.stdout;
}

it.each(['wait', 'report', 'stop'])('nudges free-text answers into a new discussion in %s output', (surface) => {
  const card = askDecision({ title: 'Merge this PR?', options: ['Merge'], grounds: 'alpha', askedBy: 'helm', maxBytes: 100 }).meta;
  answerDecision({ key: card.key, text: 'What happens to the other work?', by: 'glass', maxBytes: 100 });
  const output = surface === 'stop' ? run(['haul'], JSON.stringify({ session_id: session })) : run(surface === 'wait' ? ['wait', '--timeout', '0'] : ['report']);
  expect(output).toContain('next:');
  expect(output).toContain('this card has become a discussion');
  expect(output).toContain('man thread new --title');
  expect(output).toContain(`--link ${card.key}`);
  expect(output).toContain(`man note <thread> --link ${card.key}`);
  expect(output).toContain('man ask --thread <id>');
  expect(output).toContain('man ack');
});

it.each(['wait', 'report', 'stop'].flatMap((surface) => [false, true].map((linkedBeforeAnswer) => ({ surface, linkedBeforeAnswer }))))('names the existing thread in $surface output (linked before answer: $linkedBeforeAnswer)', ({ surface, linkedBeforeAnswer }) => {
  const thread = startHelmThread({ grounds: 'alpha', title: 'Merge approach' });
  const card = askDecision({ title: 'Merge this PR?', grounds: 'alpha', askedBy: 'helm', maxBytes: 100, ...(linkedBeforeAnswer ? { thread: thread.id } : {}) }).meta;
  answerDecision({ key: card.key, text: 'Can we discuss the approach?', by: 'glass', maxBytes: 100 });
  if (!linkedBeforeAnswer) noteThread(thread.id, { link: card.key });
  const output = surface === 'stop' ? run(['haul'], JSON.stringify({ session_id: session })) : run(surface === 'wait' ? ['wait', '--timeout', '0'] : ['report']);
  expect(output).toContain(`reuse thread ${thread.id}`);
  expect(output).toContain(`man ask --thread ${thread.id}`);
  expect(output).not.toContain('man thread new');
});

it('keeps another helm\'s answered cards out of the report', () => {
  takeHelm({ sessionId: 'other-helm', grounds: { name: 'beta', repos: [] }, ttlMs: 60_000 });
  const other = askDecision({ title: 'Other merge?', grounds: 'beta', askedBy: 'helm', maxBytes: 100 }).meta;
  answerDecision({ key: other.key, text: 'What changed?', by: 'glass', maxBytes: 100 });
  const card = askDecision({ title: 'Merge?', grounds: 'alpha', askedBy: 'helm', maxBytes: 100 }).meta;
  answerDecision({ key: card.key, text: 'Why?', by: 'glass', maxBytes: 100 });
  const output = run(['report']);
  expect(output).toContain(card.key);
  expect(output).not.toContain(other.key);
});

it('matches the implicit home grounds and its legacy fleet name', () => {
  fs.writeFileSync(path.join(home, 'config.toml'), '');
  const card = askDecision({ title: 'Merge?', grounds: 'fleet', askedBy: 'helm', maxBytes: 100 }).meta;
  expect(reusedTitleCard({ title: card.title, grounds: 'home' })?.key).toBe(card.key);
});

it('keeps option answers with explanatory text on the ordinary ack path', () => {
  const card = askDecision({ title: 'Merge?', options: ['Merge'], grounds: 'alpha', askedBy: 'helm', maxBytes: 100 }).meta;
  answerDecision({ key: card.key, option: 'Merge', text: 'After the tests pass', by: 'glass', maxBytes: 100 });
  expect(run(['wait', '--timeout', '0'])).not.toContain('has become a discussion');
  expect(run(['haul'], JSON.stringify({ session_id: session }))).not.toContain('has become a discussion');
});

it.each(['open', 'acked', 'replaced'])('creates the card and prints advice when its title repeats an %s card', (state) => {
  const card = askDecision({ title: 'Merge this PR?', grounds: 'alpha', askedBy: 'helm', maxBytes: 100 }).meta;
  if (state !== 'open') {
    answerDecision({ key: card.key, text: 'What about the other work?', by: 'glass', maxBytes: 100 });
    if (state === 'acked') ackDecision(card.key);
  }
  const output = run(['ask', '--title', card.title, ...(state === 'replaced' ? ['--replace', card.key] : [])]);
  expect(output).toContain(`note: this title repeats ${card.key}`);
  expect(output.indexOf('note:')).toBeGreaterThan(output.indexOf('url:'));
  expect(output).toContain(`man note <thread> --link ${card.key}`);
  expect(output).toContain('man thread new --title');
  expect(output).toContain('man ask --thread <id>');
  expect(listDecisions()).toHaveLength(2);
});

it.each(['old ack', 'other grounds', 'threaded', 'worker', 'different title', 'unacked', 'withdrawn'])('does not nudge for an earlier card with %s', (reason) => {
  const thread = reason === 'threaded' ? startHelmThread({ grounds: 'alpha', title: 'Merge discussion' }).id : undefined;
  const card = askDecision({ title: 'Merge?', grounds: reason === 'other grounds' ? 'beta' : 'alpha', askedBy: reason === 'worker' ? 'worker' : 'helm', thread, maxBytes: 100 }).meta;
  if (reason === 'old ack' || reason === 'unacked') {
    answerDecision({ key: card.key, text: 'Why?', by: 'glass', maxBytes: 100 });
    if (reason === 'old ack') ackDecision(card.key, { now: new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000) });
  }
  if (reason === 'withdrawn') withdrawDecision(card.key);
  const output = run(['ask', '--title', reason === 'different title' ? 'Ship?' : 'Merge?']);
  expect(output).not.toContain('note: this title repeats');
});

it('uses the ack time for the 24-hour window and keeps old open cards eligible', () => {
  const now = Date.now();
  const card = askDecision({ title: 'Merge?', grounds: 'alpha', askedBy: 'helm', maxBytes: 100, now: new Date(now - 7 * 86400_000) }).meta;
  expect(reusedTitleCard(card, now)?.key).toBeUndefined();
  expect(reusedTitleCard({ title: card.title, grounds: 'alpha' }, now)?.key).toBe(card.key);
  answerDecision({ key: card.key, text: 'Why?', by: 'glass', maxBytes: 100 });
  ackDecision(card.key, { now: new Date(now - 24 * 60 * 60 * 1000 + 1) });
  expect(reusedTitleCard({ title: card.title, grounds: 'alpha' }, now)?.key).toBe(card.key);
  expect(reusedTitleCard({ title: card.title, grounds: 'alpha' }, now + 2)).toBeUndefined();
});

it('links the earlier card into the new card\'s thread when one is supplied', () => {
  const card = askDecision({ title: 'Merge?', grounds: 'alpha', askedBy: 'helm', maxBytes: 100 }).meta;
  const thread = startHelmThread({ grounds: 'alpha', title: 'Merge discussion' });
  const output = run(['ask', '--title', 'Merge?', '--thread', thread.id]);
  expect(output).toContain(`note: this title repeats ${card.key}`);
  expect(output).toContain(`man note ${thread.id} --link ${card.key}`);
  expect(output).toContain(`man ask --thread ${thread.id}`);
});
