import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addWatch, appendStatus, ensureLayout, laneDirs, mergeEvidence, readPr, readPrs } from '@lobstah/core';
import type { Descriptor, GhPrView, PrRef } from '@lobstah/core';
import { deriveGlassPrs, dispatchPrList } from '../src/glass-prs.js';
import { observeDispatchPrWatches, observePr } from '../src/pr-watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A dispatch that reported a stack of six PRs: the daemon observed only the
 * PRs that had a record, because the dispatch's one `pr` evidence (its first
 * PR, observed every cycle) stood in for the others and looked fresh. The
 * glass builds PR stacks from records, so the stack showed #140 → #139.
 */

const ID = 'd6d6d6d6-0000-4000-8000-000000000006';
// Stack order #140 ← #139 ← #141 ← #142 ← #143 ← #145; reported in another order.
const STACK = [140, 139, 141, 142, 143, 145];
const REPORTED = [140, 145, 141, 139, 143, 142];
const url = (n: number) => `https://github.com/acme/web/pull/${n}`;
const head = (n: number) => `b${n}`;
const base = (n: number) => {
  const i = STACK.indexOf(n);
  return i === 0 ? 'main' : head(STACK[i - 1]!);
};
let home: string;

const view = (asked: number[]) => (ref: PrRef): GhPrView => {
  asked.push(ref.number);
  return {
    state: 'OPEN',
    isDraft: false,
    headRefOid: String(ref.number).repeat(8).slice(0, 40).padEnd(40, '0'),
    headRefName: head(ref.number),
    baseRefName: base(ref.number),
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [],
  };
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-observe-all-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  const done = path.join(laneDirs('work').done, ID);
  fs.mkdirSync(done, { recursive: true });
  fs.writeFileSync(path.join(done, 'descriptor.json'), JSON.stringify({ id: ID, repo: 'web', brief: 'stack' } satisfies Descriptor));
  appendStatus(ID, 'work', 'done', 'stack sent');
  mergeEvidence(ID, 'work', { prUrl: url(140), prUrls: REPORTED.map(url) });
  for (const n of REPORTED) addWatch(`pr:acme/web#${n}`, 'echo {}', { owner: `dispatch:${ID}` });
  // The first PR was just observed: its record and the dispatch's `pr` evidence are fresh.
  observePr({ owner: 'acme', repo: 'web', number: 140, key: 'pr:acme/web#140', url: url(140) }, view([])({ owner: 'acme', repo: 'web', number: 140, key: 'pr:acme/web#140', url: url(140) }), { dispatchId: ID });
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('a dispatch with a six-PR stack', () => {
  it('the daemon observes every PR, not only the one its evidence names', () => {
    const asked: number[] = [];
    observeDispatchPrWatches(45, Date.now(), view(asked));
    // #140 was just observed; each other PR is read once, though the dispatch's evidence is fresh.
    expect(asked.sort()).toEqual(STACK.filter((n) => n !== 140).sort());
    for (const n of STACK) expect(readPr(`pr:acme/web#${n}`)?.state).toBe('OPEN');
    // Within the poll interval nothing is read again.
    const again: number[] = [];
    observeDispatchPrWatches(45, Date.now(), view(again));
    expect(again).toEqual([]);
  });

  it('the glass stack and the dispatch list every PR in stack order with its state', () => {
    observeDispatchPrWatches(45, Date.now(), view([]));
    const { prs, stacks } = deriveGlassPrs([], [], readPrs());
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.numbers).toEqual(STACK);
    const list = dispatchPrList(REPORTED.map(url), prs);
    expect(list.map((p) => p.number)).toEqual(STACK);
    expect(list.every((p) => p.badge?.text === 'green' || typeof p.badge?.text === 'string')).toBe(true);
  });

  it('a PR not observed yet keeps its report order after the observed ones', () => {
    const { prs } = deriveGlassPrs([], [], []);
    expect(dispatchPrList(REPORTED.map(url), prs).map((p) => [p.number, p.badge])).toEqual(REPORTED.map((n) => [n, undefined]));
  });
});
