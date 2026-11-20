import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  askDecision,
  ensureLayout,
  linkedPrKeys,
  listRequests,
  mergeWhenGreenAnswerText,
  readDecisionAnswer,
  standingDecisions,
  upsertPr,
  withdrawDecision,
} from '@lobstah/core';
import type { DecisionMeta, GhPrView, PrEvidence, PrRef } from '@lobstah/core';
import { requestPrMerge } from '../src/pr-merge.js';
import { mergeWhenGreenCommand } from '../src/pr-merge-command.js';
import { observePr } from '../src/pr-watch.js';
import { parseArgs } from '../src/usage.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A decision card asked with `--pr` and the PR's own Merge when green: when
 * merge when green is set any other way (the glass PR card, the helm's CLI,
 * GitHub auto-merge), lobstah answers the open card and wakes the helm.
 */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-linked-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[repos.web]\npath = "/missing"\norigin = "git@github.com:acme/web.git"\nmergeMethod = "merge"\n');
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const KEY = 'pr:acme/web#7';
const REF: PrRef = { owner: 'acme', repo: 'web', number: 7, key: KEY, url: 'https://github.com/acme/web/pull/7' };
const observation = (over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: REF.url, number: 7, title: 'Tray schema', state: 'OPEN', draft: false, reviewDecision: '', mergeStateStatus: 'CLEAN',
  headSha: 'head7', baseRefName: 'main', headRefName: 'tray', author: 'chris', observedAt: new Date().toISOString(),
  checks: { total: 1, passed: 0, failed: 0, pending: 1 }, ...over,
});
/** A card asked as `man ask --pr <pr>`: its references, as decisionReferences records them. */
const ask = (prs: string[] = [KEY], title = 'Merge #7 when green?'): DecisionMeta =>
  askDecision({ title, options: ['Merge when green', 'Hold'], references: prs.map((key) => ({ kind: 'pr' as const, key })), askedBy: 'helm', maxBytes: 1024 }).meta;
const answerEvents = () => listRequests({ kind: 'decision-answer' });

describe('the cards linked to a PR', () => {
  it('are the cards asked with --pr naming it, never a permission or run card', () => {
    expect(linkedPrKeys({ references: [{ kind: 'report', key: 'r1' }, { kind: 'pr', key: KEY }, { kind: 'pr', key: 'pr:acme/web#8' }] })).toEqual([KEY, 'pr:acme/web#8']);
    expect(linkedPrKeys({ references: [{ kind: 'pr', key: KEY }], permission: true })).toEqual([]);
    expect(linkedPrKeys({ references: [{ kind: 'pr', key: KEY }], run: {} })).toEqual([]);
  });

  it('are answered in words naming where, by whom and when', () => {
    const at = '2026-11-20T18:30:00.000Z';
    expect(mergeWhenGreenAnswerText({ from: 'glass', at })).toBe(`Merge when green, set from the PR card in the glass by you at ${at}.`);
    expect(mergeWhenGreenAnswerText({ from: 'wharf', at })).toBe(`Merge when green, set from the PR card in the hosted glass by you at ${at}.`);
    expect(mergeWhenGreenAnswerText({ from: 'cli', who: 'chat', at })).toBe(`Merge when green, set from \`lobstah pr merge-when-green\` by the helm (authorized by chat) at ${at}.`);
    expect(mergeWhenGreenAnswerText({ from: 'github', who: 'dana', at })).toBe(`Merge when green, set from GitHub auto-merge by @dana at ${at}.`);
    expect(mergeWhenGreenAnswerText({ from: 'github', at })).toBe(`Merge when green, set from GitHub auto-merge by someone on GitHub at ${at}.`);
  });
});

describe('merge when green set without the card', () => {
  it('from the glass PR card answers the open card and raises a decision-answer event', () => {
    upsertPr(observation());
    const card = ask();
    const other = ask(['pr:acme/web#8'], 'Merge #8?');
    const request = requestPrMerge(KEY, 'glass', { viewer: () => 'chris' });
    const answer = readDecisionAnswer(card.key)!;
    expect(answer).toMatchObject({ by: 'glass', text: `Merge when green, set from the PR card in the glass by you at ${request.at}.` });
    expect(answer.option).toBeUndefined();
    expect(standingDecisions().map((d) => d.key)).toEqual([other.key]);
    expect(answerEvents()).toEqual([expect.objectContaining({ id: answer.request, from: 'glass', payload: expect.objectContaining({ key: card.key, text: answer.text }) })]);
  });

  it('from `lobstah pr merge-when-green` answers it as the CLI, naming the authorization', () => {
    upsertPr(observation());
    const card = ask();
    const parsed = parseArgs('pr', ['merge-when-green', 'acme/web#7', '--by', 'chat'])!;
    mergeWhenGreenCommand(parsed.positionals, {
      opt: (name) => { const v = parsed.flags.get(name); return typeof v === 'string' ? v : undefined; },
      has: (name) => parsed.flags.has(name),
    }, { methods: () => ({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false }) });
    const answer = readDecisionAnswer(card.key)!;
    expect(answer.by).toBe('cli');
    expect(answer.text).toMatch(/^Merge when green, set from `lobstah pr merge-when-green` by the helm \(authorized by chat\) at \d{4}-.+Z\.$/);
    expect(standingDecisions()).toEqual([]);
    expect(answerEvents()).toEqual([expect.objectContaining({ from: 'cli', payload: expect.objectContaining({ key: card.key }) })]);
  });

  it('on GitHub, picked up by the PR watch, answers it with the GitHub login and time', () => {
    upsertPr(observation());
    const card = ask();
    const view: GhPrView = { title: 'Tray schema', state: 'OPEN', isDraft: false, headRefOid: 'head7', mergeStateStatus: 'BLOCKED', reviewDecision: '', statusCheckRollup: [] };
    // Auto-merge off: the card stands.
    observePr(REF, { ...view, autoMergeRequest: null });
    expect(standingDecisions().map((d) => d.key)).toEqual([card.key]);
    const record = observePr(REF, { ...view, autoMergeRequest: { enabledAt: '2026-11-20T18:31:00Z', enabledBy: { login: 'dana' }, mergeMethod: 'MERGE' } });
    expect(record.autoMerge).toEqual({ enabledAt: '2026-11-20T18:31:00Z', enabledBy: 'dana', method: 'MERGE' });
    expect(readDecisionAnswer(card.key)).toMatchObject({ by: 'github', text: 'Merge when green, set from GitHub auto-merge by @dana at 2026-11-20T18:31:00Z.' });
    expect(answerEvents()).toEqual([expect.objectContaining({ from: 'github', payload: expect.objectContaining({ key: card.key }) })]);
    // Each later observation finds nothing left to answer, and turning it off clears the record.
    observePr(REF, { ...view, autoMergeRequest: { enabledAt: '2026-11-20T18:31:00Z', enabledBy: { login: 'dana' } } });
    expect(answerEvents()).toHaveLength(1);
    expect(observePr(REF, { ...view, autoMergeRequest: null }).autoMerge).toBeUndefined();
  });

  it('leaves a withdrawn card withdrawn, and a card about another PR open', () => {
    upsertPr(observation());
    const withdrawn = ask();
    withdrawDecision(withdrawn.key);
    const other = ask(['pr:acme/web#8']);
    requestPrMerge(KEY, 'glass', { viewer: () => 'chris' });
    expect(readDecisionAnswer(withdrawn.key)).toBeUndefined();
    expect(standingDecisions().map((d) => d.key)).toEqual([other.key]);
    expect(answerEvents()).toEqual([]);
  });
});
