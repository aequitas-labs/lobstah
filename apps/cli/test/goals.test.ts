import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addTodo, askDecision, answerDecision, appendStatus, claimNext, closeTodo, complete, enqueue, ensureLayout, goalDate, goalsCardTitle, loadConfig,
  parsePrRef, prEvidence, setGoalDone, setGoals, statusPath, takeHelm, upsertPr, type GhPrView } from '@lobstah/core';
import { dailyGoalsContext, goalsRecapData } from '../src/goals.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { buildGlassSnapshot } from '../src/glass.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { loadGlass } from './glass-dom.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { emptyFleet } from './fixtures/glass-snapshots.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const NOW = Date.parse('2026-10-15T12:00:00Z');
let home: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-goals-cli-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  fs.writeFileSync(path.join(home, 'clock.cjs'), `const D = Date; global.Date = class extends D { constructor(...args) { super(...(args.length ? args : [${NOW}])); } static now() { return ${NOW}; } };`);
  fs.writeFileSync(path.join(home, 'config.toml'), `[helm]\ntimezone = "America/New_York"\n[repos.r]\npath = ${JSON.stringify(home.replace(/\\/g, '/'))}\norigin = "https://github.com/acme/r.git"\n[grounds.day]\nrepos = ["r"]\n`);
});
afterEach(() => { vi.useRealTimers(); delete process.env.LOBSTAH_HOME; removeTempDir(home); });
const run = (...args: string[]) => spawnSync(process.execPath, ['--require', path.join(home, 'clock.cjs'), cli, ...args], { env: { ...process.env, LOBSTAH_HOME: home }, encoding: 'utf8', timeout: 15000 });

it('CLI reads/writes goals and past recaps, and refuses a different session writing the helm grounds', () => {
  takeHelm({ sessionId: 'helm', grounds: { name: 'day', repos: ['r'] }, ttlMs: 60000 });
  const command = (...args: string[]) => run('goals', ...args, '--grounds', 'day', '--session', 'helm');
  expect(command('set', 'Ship it', 'Review it').status).toBe(0);
  expect(command().stdout).toContain('1. Ship it\n2. Review it');
  expect(command('add', 'Later').stdout).toContain('3. Later');
  expect(command('done', '2').stdout).toContain('2. [x] Review it');
  expect(run('goals', 'undo', '2', '--grounds', 'day', '--session', 'other').status).toBe(1);
  expect(command('undo', '2').stdout).toContain('2. [ ] Review it');
  expect(command('done', '99').status).toBe(1);
  const removed = command('rm', '2');
  expect(removed.status, removed.stderr).toBe(0);
  expect(removed.stdout).toContain('1. Ship it\n2. Later');
  expect(removed.stdout).not.toContain('Review it');
  expect(command('rm', '99').status).toBe(1);
  expect(run('goals', 'set', 'No', '--grounds', 'day', '--session', 'other').status).toBe(1);
  const recap = path.join(home, 'recap.md'); fs.writeFileSync(recap, 'Done: reviewed.');
  expect(command('recap', '2026-10-14', '--file', recap).status).toBe(0);
  expect(command('2026-10-14').stdout).toContain('## Recap\n\nDone: reviewed.');
});

it('prompt reminder crosses 04:00 once per grounds/day, across sessions and configured zones', () => {
  const cfg = loadConfig();
  const before = new Date('2026-10-15T07:59:59Z'), after = new Date('2026-10-15T08:00:00Z');
  expect(dailyGoalsContext('day', cfg, before)).toContain('2026-10-14');
  expect(dailyGoalsContext('day', cfg, before)).toBeUndefined();
  const note = dailyGoalsContext('day', cfg, after)!;
  expect(note).toContain('First message of the day (2026-10-15');
  expect(note).toContain('After handling this message');
  expect(note).toContain('recap-data 2026-10-14');
  expect(note).toContain('done, moved, stuck, plus also done');
  expect(dailyGoalsContext('day', cfg, after)).toBeUndefined();
  setGoals('day', '2026-10-16', ['Already written']);
  expect(dailyGoalsContext('day', cfg, new Date('2026-10-16T12:00:00Z'))).toBeUndefined();
});

it('an existing canonical goals card suppresses another prompt without a marker', () => {
  askDecision({ title: goalsCardTitle('2026-10-15'), grounds: 'day', askedBy: 'helm', maxBytes: 1024 });
  expect(dailyGoalsContext('day', loadConfig(), new Date('2026-10-15T12:00:00Z'))).toBeUndefined();
});

it('recap facts include active/done dispatch results, opened/merged PRs, answered cards and optional closed to-dos, scoped to the goals day', () => {
  const at = '2026-10-15T07:59:59Z'; // still the 14th's goals day
  for (const [id, repo, verb, when] of [['done', 'r', 'done', at], ['failed', 'r', 'failed', at], ['other', 'foreign', 'done', at], ['next', 'r', 'done', '2026-10-15T08:00:00Z']] as const) {
    enqueue({ id, repo, brief: 'b' }); claimNext('work'); appendStatus(id, 'work', verb, id);
    fs.writeFileSync(statusPath(id, 'work'), JSON.stringify({ verb, at: when, note: id }) + '\n');
    if (id === 'done') complete(id, 'work');
  }
  const ref = parsePrRef('acme/r#1')!;
  const view: GhPrView = { state: 'MERGED', isDraft: false, headRefOid: 'abc', createdAt: at, mergedAt: at };
  upsertPr(prEvidence(ref, view, '2026-10-16T12:00:00Z'));
  const { meta } = askDecision({ title: 'Ship?', grounds: 'day', askedBy: 'helm', maxBytes: 1024 });
  answerDecision({ key: meta.key, text: 'Yes', by: 'cli', now: new Date(at), maxBytes: 1024 });
  fs.mkdirSync(path.join(home, 'todos'));
  fs.writeFileSync(path.join(home, 'todos', 'day.json'), JSON.stringify({ items: [{ id: 1, text: 'Closed', state: 'done', updatedAt: at }, { id: 2, text: 'Open', state: 'open', updatedAt: at }, { id: 3, text: 'Dropped', state: 'dropped', updatedAt: at }] }));
  setGoals('day', '2026-10-14', ['Ship it', 'Review it']); setGoalDone('day', '2026-10-14', 1, true);
  const data = goalsRecapData('day', '2026-10-14', loadConfig());
  expect(data.dispatches.map((d) => d.id).sort()).toEqual(['done', 'failed']);
  expect(data.prs).toHaveLength(1); expect(data.prs[0]?.openedAt).toBe(at); expect(data.prs[0]?.mergedAt).toBe(at);
  expect(data.cards[0]?.text).toBe('Yes'); expect(data.todos.map((t) => t.id)).toEqual([1, 3]);
  expect(data.goals.lines).toEqual(['[x] Ship it', 'Review it']);
  const output = run('goals', 'recap-data', '2026-10-14', '--grounds', 'day');
  expect(output.status, output.stderr).toBe(0); expect(JSON.parse(output.stdout).dispatches).toHaveLength(2);
});

it.each(['table', 'cards'])('shows checked goals and full text in tend and the On deck %s callout', async (view) => {
  const date = goalDate(new Date(), loadConfig().helm.timezone);
  const long = 'Review every part of the handoff and preserve the full goal text rather than clipping the explanation. '.repeat(4);
  setGoals('day', date, ['First priority <safe>', long.trim()]); setGoalDone('day', date, 1, true);
  setGoals('day', '2025-01-01', ['Old priority']);
  const report = buildTendReport();
  expect(renderTend(report).startsWith(`goals — day · ${date}\n- [x] First priority <safe>`)).toBe(true);
  expect(renderTend(report)).toContain(long.trim());
  expect(buildGlassSnapshot().goals).toEqual([{ grounds: 'day', date, lines: ['[x] First priority <safe>', long.trim()] }]);
  const snapshot = emptyFleet(); snapshot.goals = report.goals;
  const page = await loadGlass(GLASS_PAGE, snapshot, { now: Date.now(), prefs: { view } });
  try {
    expect(page.$('#deck > #daily-goals')?.textContent).toContain(date);
    expect(page.$('#daily-goals ol li')?.textContent).toBe('First priority <safe>');
    const boxes = page.$$('#daily-goals input') as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[true, true], [false, true]]);
    expect(page.$('#daily-goals s')?.textContent).toBe('First priority <safe>');
    expect(page.$$('#daily-goals ol li')[1]?.textContent).toBe(long.trim());
    expect(page.$('#deck')?.firstElementChild?.id).toBe('daily-goals');
    expect(page.$('#daily-goals safe')).toBeNull();
    await page.go('#reports');
    expect(page.$('#daily-goals')).toBeNull();
    await page.go('#deck');
    expect(page.$('#daily-goals ol li')?.textContent).toBe('First priority <safe>');
  } finally { await page.close(); }
});

it('hides the callout when no goals are set and keeps tend unchanged', async () => {
  const date = goalDate(new Date(), loadConfig().helm.timezone);
  expect(buildTendReport().goals).toEqual([]);
  expect(renderTend(buildTendReport())).not.toContain('goals —');
  expect(buildGlassSnapshot().goals).toEqual([]);
  const snapshot = emptyFleet(); snapshot.goals = [{ grounds: 'day', date, lines: [] }];
  const page = await loadGlass(GLASS_PAGE, snapshot, { now: Date.now() });
  try {
    expect(page.$('#daily-goals')).toBeNull();
  } finally { await page.close(); }
});

it.each(['table', 'cards'])('renders Todos as a read-only checklist with full safe text in %s view', async (view) => {
  const long = 'Read the whole handoff, including the detailed evidence and the final verification notes, without cutting off this reminder. '.repeat(4) + '<safe>';
  addTodo('day', long); const closed = addTodo('day', 'Already done'); closeTodo('day', closed.id, 'done');
  const report = buildTendReport();
  expect(renderTend(report)).toContain(long);
  expect(renderTend(report)).not.toContain('to-dos');
  const snapshot = emptyFleet(); snapshot.todos = buildGlassSnapshot().todos;
  const page = await loadGlass(GLASS_PAGE, snapshot, { now: Date.now(), prefs: { view } });
  try {
    expect(page.$('.todos h2')?.textContent).toBe('Todos');
    expect(page.$('.todo-checklist .todo-text')?.textContent).toBe(long);
    const boxes = page.$$('.todo-checklist input[type="checkbox"]') as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[false, true]]);
    expect(page.$('.todo-checklist safe')).toBeNull();
    expect(page.$('.todo-checklist')?.textContent).not.toContain('Already done');
  } finally { await page.close(); }
});
