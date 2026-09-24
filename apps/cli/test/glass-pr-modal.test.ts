import { describe, expect, it } from 'vitest';
import * as detector from '../src/glass-diff.js';

// The PR modal's pure data selection, imported exactly as the page's bundle imports it.
type View = {
  pr: { key: string; number: number };
  stack: { numbers: number[]; position: number; size: number; floor: string; nextNumber?: number; nextMergeable: boolean; blockedBy?: number } | null;
  chain: Array<{ id: string; verb?: string; modalKey?: string; culled?: boolean }>;
  watch: { key: string; owner: string; lastCheckedAt: string | null; lastError: string | null; cursor: string } | null;
};
const page = detector as unknown as {
  prModalView: (d: unknown, key: string) => View | null;
  watchState: (w: unknown) => { text: string; at: string | null };
  sectionHashes: (d: unknown, ui: unknown, now: number) => Record<string, string>;
  dirtySections: (a: Record<string, string>, b: Record<string, string>) => string[];
};

const watch = { key: 'pr:acme/web#9', owner: 'dispatch:d2', cursor: 'eyJoIjoiYWJj…a-long-opaque-cursor', lastCheckedAt: '2026-09-23T18:00:00Z' };
const snap = {
  dispatches: [
    { id: 'd1', lane: 'work', verb: 'done' },
    { id: 'd2', lane: 'work', verb: 'working' },
  ],
  prs: [
    { key: 'pr:acme/web#8', number: 8, stackId: 's', position: 0, nextMergeable: true, dispatchIds: ['d1'] },
    { key: 'pr:acme/web#9', number: 9, stackId: 's', position: 1, nextMergeable: false, blockedBy: 8, dispatchIds: ['d1', 'd2', 'gone0000-culled'], watch },
  ],
  stacks: [{ id: 's', floor: 'main', numbers: [8, 9], nextNumber: 8 }],
};

describe('PR modal data', () => {
  it('selects the PR, its stack position and blocker, the linked chain, and the watch with its cursor', () => {
    const v = page.prModalView(snap, 'pr:acme/web#9')!;
    expect(v.pr.number).toBe(9);
    expect(v.stack).toEqual({ numbers: [8, 9], position: 2, size: 2, floor: 'main', nextNumber: 8, nextMergeable: false, blockedBy: 8 });
    expect(v.chain).toEqual([
      { id: 'd1', verb: 'done', modalKey: 'work:d1' },
      { id: 'd2', verb: 'working', modalKey: 'work:d2' },
      { id: 'gone0000-culled', culled: true },
    ]);
    expect(v.watch).toEqual({ key: 'pr:acme/web#9', owner: 'dispatch:d2', lastCheckedAt: '2026-09-23T18:00:00Z', lastError: null, cursor: watch.cursor });
  });

  it('a PR with no watch and no stack still opens; an unknown key opens nothing', () => {
    const lone = { dispatches: [], prs: [{ key: 'pr:acme/web#3', number: 3, stackId: 'x', position: 0, dispatchIds: [] }], stacks: [] };
    expect(page.prModalView(lone, 'pr:acme/web#3')).toMatchObject({ stack: null, chain: [], watch: null });
    expect(page.prModalView(lone, 'pr:acme/web#404')).toBeNull();
  });

  it('the PRs table shows a short watch state, never the cursor', () => {
    expect(page.watchState(watch)).toEqual({ text: 'watching', at: '2026-09-23T18:00:00Z' });
    expect(page.watchState(undefined)).toEqual({ text: 'no watch', at: null });
    expect(JSON.stringify(page.watchState(watch))).not.toContain('cursor');
  });

  it('the open PR modal re-renders only when its PR changes', () => {
    const d = { helms: [], traps: [], notices: [], watches: [], ...snap };
    const ui = { st: { view: 'table', q: '' }, open: new Set(), modal: { type: 'pr', key: 'pr:acme/web#9' } };
    const a = page.sectionHashes(d, ui, 0);
    const other = structuredClone(d);
    other.prs[0]!.nextMergeable = false;
    expect(page.dirtySections(a, page.sectionHashes(other, ui, 0))).not.toContain('modal');
    const own = structuredClone(d);
    (own.prs[1] as { watch: typeof watch }).watch = { ...watch, lastCheckedAt: '2026-09-23T18:05:00Z' };
    expect(page.dirtySections(a, page.sectionHashes(own, ui, 0))).toContain('modal');
  });
});
