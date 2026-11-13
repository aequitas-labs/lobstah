import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimBait, enqueue, ensureLayout, mergeEvidence, signOnTrap, upsertPr } from '@lobstah/core';
import type { PrEvidence } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { dispatchPrHead } from '../src/glass-prs.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-head-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const id = 'bf98cbe8-1111-2222-3333-444444444444';
const url = (n: number) => `https://github.com/acme/web/pull/${n}`;
const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const obs = (n: number, over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: url(n),
  number: n,
  state: 'OPEN',
  draft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  mergeStateStatus: 'BLOCKED',
  headSha: `sha${n}`,
  baseRefName: 'main',
  headRefName: `branch-${n}`,
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  review: { unresolvedThreads: 0, changesRequested: false },
  observedAt: at(1),
  ...over,
});

/** A working dispatch whose first PR, #10, merged an hour ago. */
function movedOn(): void {
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const signed = signOnTrap({ sessionId: 's', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  enqueue({ id, repo: 'web', brief: 'retire v11' });
  expect(claimBait(signed.ok)?.id).toBe(id);
  mergeEvidence(id, 'work', { prUrl: url(10) });
  upsertPr(obs(10, { state: 'MERGED', mergedAt: at(60), observedAt: at(59) }), id);
}

const head = () => buildGlassSnapshot().dispatches.find((d) => d.id === id)!.prHead;

/** The dispatch's catch in its trap's modal, where its dispatch card opens the PR outputs. */
async function catchText(snap: ReturnType<typeof buildGlassSnapshot>): Promise<string> {
  const g = await loadGlass(GLASS_PAGE, snap, { hash: '#traps', prefs: { view: 'cards' } });
  try {
    (g.$('#traps .card') as HTMLElement).click();
    await g.settle();
    const card = g.$('.trap-current .card')!;
    (card as HTMLElement).click(); await g.settle();
    return (g.$('.dispatch-prs')!.textContent ?? '').replace(/\s+/g, ' ');
  } finally {
    await g.close();
  }
}

describe("a dispatch card's PR", () => {
  it('drops a merged PR the dispatch has reported past, and shows the next one once it opens', async () => {
    movedOn();
    appendStatus(id, 'work', 'paused', 'waiting on #10', at(90));
    // Parked on #10 when it merged: the merge is the news.
    expect(head()).toMatchObject({ number: 10, badge: { text: 'merged' }, open: 0 });

    appendStatus(id, 'work', 'working', 'Building PR 1', at(5));
    expect(head()).toBeUndefined();
    const snap = buildGlassSnapshot();
    expect(await catchText(snap)).toContain('Merged');

    mergeEvidence(id, 'work', { prUrls: [url(10), url(11)] });
    upsertPr(obs(11), id);
    expect(head()).toMatchObject({ number: 11, badge: { text: 'review' }, open: 1, several: true });
  });

  it('a stack leads with its top PR and counts the open ones', async () => {
    movedOn();
    appendStatus(id, 'work', 'working', 'stack up', at(5));
    mergeEvidence(id, 'work', { prUrls: [url(10), url(11), url(12), url(13)] });
    upsertPr(obs(11), id);
    upsertPr(obs(12, { baseRefName: 'branch-11' }), id);
    upsertPr(obs(13, { baseRefName: 'branch-12', draft: true }), id);
    expect(head()).toMatchObject({ number: 13, badge: { text: 'draft' }, open: 3 });

    const output = await catchText(buildGlassSnapshot());
    for (const number of [11, 12, 13]) expect(output).toContain('#'+number);
    expect(output).toContain('Draft');
  });

  it('a finished dispatch keeps its merged PR', () => {
    const merged = obs(10, { state: 'MERGED', mergedAt: at(60) });
    const pick = (bucket: 'active' | 'done') => dispatchPrHead([url(10)], () => merged, [], { bucket, verbAt: at(5) });
    expect(pick('done')).toMatchObject({ number: 10, badge: { text: 'merged' }, several: false });
    expect(pick('active')).toBeUndefined();
  });

  it('keeps the saved top PR when stack branches have been retargeted', () => {
    movedOn();
    appendStatus(id, 'work', 'working', 'retargeted stack', at(5));
    mergeEvidence(id, 'work', {
      prUrls: [url(13), url(11), url(12)],
      prPositions: Object.fromEntries([11, 12, 13].map((number, index) => [url(number), { bottom: url(11), position: index + 1, size: 3 }])),
    });
    for (const number of [11, 12, 13]) upsertPr(obs(number), id);
    expect(head()).toMatchObject({ number: 13, open: 3 });
  });
});
