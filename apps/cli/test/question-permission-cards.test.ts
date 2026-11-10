import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimBait, enqueue, ensureLayout, readDecisionAnswer, signOnTrap, standingDecisions } from '@lobstah/core';
import type { DecisionMeta, GlassFullSnapshot } from '@lobstah/core';
import { answerKey } from '../src/decision-answer.js';
import { buildGlassSnapshot } from '../src/glass.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { NOW } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A trap's question and its permission request are two cards. A trap that
 * reports needs-decision with a question and, around the same time, a
 * refused command (`report needs-decision --ask`) gets a decision card for
 * the question, with free text, and a permission card with Allow once,
 * Allow always and No. Either can come first, both stand together, and
 * answering one never answers or clears the other.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = '22222222-3333-4444-8555-666666666666';
const DISPATCH = 'bbbbbbbb-2222-4bbb-8bbb-222222222222';
/** The question card's key: a raw question is keyed by its dispatch. */
const QUESTION = `work:${DISPATCH}`;
const QUESTION_TEXT = 'Ship the tray as (a) one PR or (b) a stack of two?';
const COMMAND = 'npm publish --dry-run';
let home: string;
let worktree: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-question-permission-')));
  process.env.LOBSTAH_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  process.env.CODEX_HOME = path.join(home, 'codex');
  ensureLayout();
  worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = "${worktree.replace(/\\/g, '/')}"\ntrunk = "main"\n`);
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness: 'claude', sessionId: SESSION, name: 'amber-gull', ttlMs: 3_600_000 });
  if (!('ok' in signed)) throw new Error('the trap could not sign on');
  enqueue({ id: DISPATCH, repo: 'web', brief: 'Build the tray', for: `wt:${signed.ok.trapId}` });
  claimBait(signed.ok);
});
afterEach(() => {
  removeTempDir(home);
  for (const key of ['LOBSTAH_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete process.env[key];
});

/** `lobstah report <dispatch> needs-decision <note> [args]`, run as the trap. */
function reportNeedsDecision(note: string, ...args: string[]): void {
  const out = spawnSync(process.execPath, [cli, 'report', DISPATCH, 'needs-decision', note, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    cwd: worktree,
    env: { ...process.env, LOBSTAH_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION },
  });
  expect(out.status, out.stderr).toBe(0);
}

const askQuestion = (): void => reportNeedsDecision(QUESTION_TEXT);
const askPermission = (): void => reportNeedsDecision('The release check needs a dry-run publish', '--ask', COMMAND);

/** The dispatch's standing permission card. */
function permissionCard(): DecisionMeta {
  const card = standingDecisions().find((d) => d.dispatch === DISPATCH && d.permission);
  expect(card, 'a permission card stands').toBeTruthy();
  return card!;
}

/** The keys of the question cards the glass shows. */
const questionKeys = (snapshot: GlassFullSnapshot): string[] => snapshot.attention.filter((a) => a.kind === 'question').map((a) => a.key);

const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Both cards on the glass's deck: the question with its own words, the permission request with its buttons. */
async function expectTwoCards(): Promise<void> {
  const card = permissionCard();
  const snapshot = buildGlassSnapshot();
  expect(questionKeys(snapshot)).toEqual([QUESTION]);
  expect(snapshot.attention.find((a) => a.key === QUESTION)?.note).toBe(QUESTION_TEXT);
  expect(snapshot.decisions.map((d) => d.key)).toEqual([card.key]);
  const glass = await loadGlass(GLASS_PAGE, snapshot, { now: NOW });
  try {
    const rows = glass.$$('#deck .dlist > .drow').map((r) => r.getAttribute('data-decision'));
    expect(rows.sort()).toEqual([card.key, QUESTION].sort());
    const question = glass.$$('#deck .drow').find((r) => r.getAttribute('data-decision') === QUESTION)!;
    expect(text(question.querySelector('.dtitle'))).toBe(QUESTION_TEXT);
    const permission = glass.$$('#deck .drow').find((r) => r.getAttribute('data-decision') === card.key)!;
    expect(text(permission.querySelector('.dtitle'))).toContain(COMMAND);
  } finally {
    await glass.close();
  }
}

describe.each([
  ['the question first, then the permission request', [askQuestion, askPermission]],
  ['the permission request first, then the question', [askPermission, askQuestion]],
] as const)('a trap files %s', (_order, steps) => {
  beforeEach(() => {
    for (const step of steps) step();
  });

  it('gets two cards: the question and the permission request', async () => {
    await expectTwoCards();
  });

  it('answering the permission request leaves the question standing', () => {
    const card = permissionCard();
    answerKey(card.key, { option: 'Allow once', by: 'glass' });
    expect(readDecisionAnswer(card.key)?.option).toBe('Allow once');
    const snapshot = buildGlassSnapshot();
    expect(questionKeys(snapshot)).toEqual([QUESTION]);
    expect(snapshot.attention.find((a) => a.key === QUESTION)?.note).toBe(QUESTION_TEXT);
    // The question can still be answered in its own words.
    const { answer } = answerKey(QUESTION, { text: '(b), a stack of two', by: 'glass' });
    expect(answer.text).toBe('(b), a stack of two');
  });

  it('answering the question leaves the permission request open', () => {
    const card = permissionCard();
    const { decision, answer } = answerKey(QUESTION, { text: '(a), one PR', by: 'glass' });
    expect(decision.permission).toBeUndefined();
    expect(answer.text).toBe('(a), one PR');
    expect(readDecisionAnswer(card.key)).toBeUndefined();
    expect(buildGlassSnapshot().decisions.map((d) => d.key)).toContain(card.key);
    // The permission card still takes its own answer.
    answerKey(card.key, { option: 'No', by: 'glass' });
    expect(readDecisionAnswer(card.key)?.option).toBe('No');
  });
});

describe('a permission request on its own', () => {
  it('is one permission card, with no question card beside it', () => {
    askPermission();
    const card = permissionCard();
    const snapshot = buildGlassSnapshot();
    expect(questionKeys(snapshot)).toEqual([]);
    expect(snapshot.decisions.map((d) => d.key)).toEqual([card.key]);
  });
});
