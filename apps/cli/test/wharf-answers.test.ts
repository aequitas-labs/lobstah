import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, listGrants, readDecisionAnswer, standingDecisions, unhandled } from '@lobstah/core';
import type { CardAnswerReceipt, DecisionMeta, TendAttention } from '@lobstah/core';
import { askPermission } from '../src/grants-cli.js';
import { applyReceipt, ALLOW_HERE_ONLY } from '../src/wharf-answers.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-answers-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '');
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

const card = (): DecisionMeta => askPermission({ dispatch: 'd-1', lane: 'work', ask: { command: 'wrangler deploy', harness: 'codex' } });
/** What this boat's attention shows for a decision: its key and the state it stands on. */
const shown = (d: DecisionMeta): TendAttention[] => [{ kind: 'decision', key: d.key, stateHash: d.stateHash, id: d.key, lane: 'work', verb: 'decision', ageSecs: 0 }];
let n = 0;
const receipt = (d: DecisionMeta, action: CardAnswerReceipt['action'], extra: Partial<CardAnswerReceipt> = {}): CardAnswerReceipt => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, family: 'permission', key: d.key, stateHash: d.stateHash, revision: 1,
  action, by: 'person-a', at: new Date().toISOString(), state: 'pending', ...extra,
});
const on = { wharfRemoteAnswers: { cloud: true } }, off = { wharfRemoteAnswers: { cloud: false } };

it('an Allow once from the wharf writes the grant a glass click writes, by its receipt, once', () => {
  const d = card(); const r = receipt(d, { kind: 'allow-once' });
  const first = applyReceipt(on, 'cloud', r, shown(d));
  expect(first).toEqual({ state: 'applied', outcome: expect.stringMatching(/^grant /) });
  expect(listGrants().grants).toEqual([expect.objectContaining({ command: 'wrangler deploy', mode: 'once', harness: 'codex', by: `wharf:${r.id}`, dispatch: 'd-1' })]);
  expect(readDecisionAnswer(d.key)).toMatchObject({ option: 'Allow once', by: 'wharf', receipt: r.id });
  expect(unhandled('d-1', 'work').at(-1)!.text).toContain('through the wharf');
  // The same receipt again is the same outcome, and no second grant.
  expect(applyReceipt(on, 'cloud', r, shown(d))).toEqual(first);
  expect(listGrants().grants).toHaveLength(1);
});

it('a boat that takes Allow only in its own glass refuses it; No still answers', () => {
  const d = card();
  expect(applyReceipt(off, 'cloud', receipt(d, { kind: 'allow-always' }), shown(d))).toEqual({ state: 'refused', outcome: ALLOW_HERE_ONLY });
  expect(listGrants().grants).toEqual([]);
  expect(standingDecisions().map((x) => x.key)).toContain(d.key);
  expect(applyReceipt(off, 'cloud', receipt(d, { kind: 'deny' }), shown(d))).toEqual({ state: 'applied', outcome: 'answered' });
  expect(listGrants().grants).toEqual([]);
  expect(unhandled('d-1', 'work').at(-1)!.text).toContain('Do not run it');
});

it('applies only to the exact state answered, and free text or seen never grant', () => {
  const d = card();
  expect(applyReceipt(on, 'cloud', receipt(d, { kind: 'allow-once' }, { stateHash: 'an-older-state' }), shown(d))).toMatchObject({ state: 'refused' });
  expect(applyReceipt(on, 'cloud', receipt(d, { kind: 'allow-once' }), [])).toMatchObject({ state: 'refused' });
  // A permission card takes options, not words: free text is refused and grants nothing.
  expect(applyReceipt(on, 'cloud', receipt(d, { kind: 'answer-text' }, { text: 'sure, go ahead' }), shown(d))).toMatchObject({ state: 'refused' });
  expect(applyReceipt(on, 'cloud', receipt(d, { kind: 'seen' }), shown(d))).toEqual({ state: 'applied', outcome: 'seen' });
  expect(listGrants().grants).toEqual([]);
  expect(standingDecisions().map((x) => x.key)).toContain(d.key);
});

it('after a crash between applying and recording, the same receipt finishes once', () => {
  const d = card(); const r = receipt(d, { kind: 'allow-once' });
  applyReceipt(on, 'cloud', r, shown(d));
  // As if the boat stopped after the answer, before its ledger said so.
  fs.writeFileSync(path.join(home, 'wharf-answers', 'cloud', `${r.id}.json`), '{"state":"applying"}');
  expect(applyReceipt(on, 'cloud', r, [])).toMatchObject({ state: 'applied' });
  expect(listGrants().grants).toHaveLength(1);
});

it('remoteAnswers is on for each listed wharf unless that boat sets it false', async () => {
  const { loadConfig } = await import('@lobstah/core');
  const wharf = (extra: string) => `[wharves.cloud]\nurl = 'https://wharf.invalid'\naccount = 'person'\ntokenEnv = 'LOBSTAH_TEST_TOKEN'\n${extra}\n`;
  fs.writeFileSync(path.join(home, 'config.toml'), wharf(''));
  expect(loadConfig().wharfRemoteAnswers).toEqual({ cloud: true });
  fs.writeFileSync(path.join(home, 'config.toml'), wharf('remoteAnswers = false'));
  expect(loadConfig().wharfRemoteAnswers).toEqual({ cloud: false });
  expect(loadConfig().wharves?.cloud).toEqual({ kind: 'wharf', url: 'https://wharf.invalid', account: 'person', tokenEnv: 'LOBSTAH_TEST_TOKEN' });
  fs.writeFileSync(path.join(home, 'config.toml'), wharf("remoteAnswers = 'no'"));
  expect(() => loadConfig()).toThrow('remoteAnswers must be true or false');
});
