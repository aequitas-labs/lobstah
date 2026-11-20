import { describe, expect, it } from 'vitest';
import { validateWatchPresentation } from '@lobstah/watch-types';
import type { WatchItem } from '@lobstah/watch-types';
import { GITHUB_SOURCE, reviewEffectActions, reviewWatchItem } from '../src/review-items.js';
import type { GlassReview } from '../src/glass.js';

const at = '2026-11-19T10:00:00.000Z';
function review(over: Partial<GlassReview> = {}): GlassReview {
  return {
    key: 'review:acme/web#7',
    url: 'https://github.com/acme/web/pull/7',
    reviewUrl: 'https://github.com/acme/web/pull/7',
    repo: 'acme/web',
    number: 7,
    title: 'Keep drafts visible',
    author: 'dana',
    repoKey: 'web',
    requestedBy: 'maya',
    requestedAt: at,
    state: 'requested',
    stands: true,
    headSha: 'aaaaaaa1',
    prHeadSha: 'aaaaaaa1',
    roundId: 'round-1',
    ...over,
  };
}
const item = (over: Partial<GlassReview> = {}, merge?: Parameters<typeof reviewWatchItem>[1]['merge']): WatchItem =>
  reviewWatchItem(review(over), { canDraft: true, publish: false, merge });
const controls = (value: WatchItem) => value.actions.map((action) => `${action.placement}:${action.id}`);

describe('GitHub review items', () => {
  it('keeps the PR lifecycle separate from the review round and seen state', () => {
    const posted = item({ state: 'posted', verdict: 'approve', postedAt: at, stands: false, seenAt: at });
    expect(posted.lifecycle).toEqual({ phase: 'active', label: 'Open' });
    expect(posted.statuses.map((status) => status.label)).toEqual(['approved', 'Posted']);
    expect(posted.attention).toBe('ready');
    expect(posted.answered).toBe(true);
    expect(posted.resolved).toBe(true);
    expect(posted.notification).toMatchObject({ unread: false, seen: true });
    // A merged PR with a drafted round is completed, whatever the round says.
    const merged = item({ prState: 'MERGED', state: 'drafted' });
    expect(merged.lifecycle).toEqual({ phase: 'completed', label: 'Merged' });
    expect(merged.standing).toBe(false);
    expect(item({ prState: 'CLOSED', state: 'closed' }).lifecycle).toEqual({ phase: 'closed', label: 'Closed' });
    expect(item({ prDraft: true }).lifecycle).toEqual({ phase: 'draft', label: 'Draft' });
    // Seeing an item changes neither its lifecycle nor its controls' revision.
    expect(item({ seenAt: at }).revision).toBe(item().revision);
    expect(item({ seenAt: at }).lifecycle).toEqual(item().lifecycle);
    expect(item({ state: 'drafted' }).revision).not.toBe(item().revision);
  });

  it('keeps the round words, unread mark and counts the Reviews page used', () => {
    const drafted = item({ state: 'drafted', notification: { kind: 'draft-ready', at, text: 'Draft ready' } });
    expect(drafted.statuses[0]).toMatchObject({ label: 'Ready to post', meaning: 'ready' });
    expect(drafted.notification).toMatchObject({ unread: true, action: 'review-seen' });
    expect(drafted.standing).toBe(true);
    expect(item({ state: 'failed' })).toMatchObject({ attention: 'error', statuses: [{ label: 'failed', meaning: 'failed' }] });
    expect(item({ reReview: { headSha: 'b', at }, state: 'posted' })).toMatchObject({ attention: 'needs-you', answered: false, standing: true });
    expect(item({ state: 'stale' })).toMatchObject({ attention: 'none', statuses: [{ label: 'Updating' }] });
    expect(item({ mutedAt: at }).statuses.map((status) => status.label)).toContain('muted');
  });

  it('offers the controls the review card offered, each bound to a review handler', () => {
    expect(controls(item({ state: 'drafted', verdict: 'approve', staged: true, stagedReviewUrl: 'https://github.com/acme/web/pull/7#pullrequestreview-1' }))).toEqual([
      'primary:publish',
      'menu:approve-anyway',
      'menu:skip',
      'menu:redraft',
      'menu:mute',
      'open:open',
    ]);
    const publish = item({ state: 'drafted', verdict: 'approve' }).actions[0]!;
    expect(publish).toMatchObject({ label: 'Publish', glyph: 'approve', title: 'Publish approval', binding: { effect: { action: 'review-approve' } } });
    expect(item({ state: 'drafted', staged: true, stagedReviewUrl: 'https://x.test/draft' }).actions.at(-1)).toMatchObject({ label: 'Open draft', acknowledges: true, binding: { link: { href: 'https://x.test/draft' } } });
    expect(controls(item())).toEqual(['primary:draft', 'menu:approve-anyway', 'menu:skip', 'menu:mute', 'open:open']);
    // A stale draft is being updated: Publish waits, as the card showed it.
    expect(controls(item({ state: 'stale' }))).toEqual(['primary:publish', 'menu:skip', 'menu:mute', 'open:open']);
    expect(item({ state: 'stale' }).actions[0]).toMatchObject({ label: 'Updating…', enabled: false });
    expect(controls(item({ mutedAt: at }))).toEqual(['primary:unmute', 'menu:approve-anyway']);
    // Unanswered decisions block publishing with the draft's own reason.
    const decisions = [{ id: 'd1', question: 'Ship?', options: [{ id: 'yes', label: 'Yes' }] }] as unknown as GlassReview['decisions'];
    expect(item({ state: 'drafted', decisions }).actions[0]).toMatchObject({ id: 'publish', enabled: false });
    // Approving without the draft needs a confirmation in the page.
    expect(item().actions.find((action) => action.id === 'approve-anyway')?.confirm?.title).toBe('Approve #7?');
    // A requested merge can be cancelled from the review card.
    const merging = item({}, { state: 'OPEN', summary: 'Waiting on CI', baseRefName: 'main', method: 'squash' });
    expect(merging.actions[0]).toMatchObject({ id: 'cancel-merge', pressed: true, title: 'Merges #7 into main as one squashed commit once green; click to cancel' });
    expect(merging.statuses.at(-1)).toMatchObject({ label: 'Merge when green', note: 'Waiting on CI' });
  });

  it('fills the shared slots without inventing values', () => {
    const value = item({ dispatch: 'job-1', automatic: true, askerName: 'Maya', summary: 'Looks good', blocking: [{ path: 'a.ts', line: 3, body: 'Bug' }] as GlassReview['blocking'] });
    expect(value.metadata).toEqual([
      { kind: 'project', value: 'acme/web' },
      { kind: 'time', value: at },
      { kind: 'reference', value: '#7' },
      { kind: 'owner', value: 'dispatch:job-1' },
      { kind: 'person', value: 'dana', label: 'author' },
    ]);
    expect(value.person).toMatchObject({ id: 'maya', name: 'Maya', role: 'requested by', badge: { label: 'automatic' } });
    expect(value.notes).toEqual([{ label: 'Summary', text: 'Looks good' }, { text: 'a.ts:3 · Bug', meaning: 'failed' }]);
    expect(value.target).toEqual({ open: { type: 'review', key: 'review:acme/web#7' } });
    expect(value.repo).toBe('web');
    expect(item({ repoKey: undefined }).repo).toBeUndefined();
  });

  it('validates as presentation v2 for every state', () => {
    const states: Array<Partial<GlassReview>> = [
      {},
      { state: 'drafted', staged: true, stagedReviewUrl: 'https://github.com/acme/web/pull/7#pullrequestreview-1' },
      { state: 'posted', verdict: 'request_changes', postedAt: at },
      { state: 'stale' },
      { state: 'failed' },
      { state: 'dismissed' },
      { prState: 'MERGED', state: 'merged' },
      { mutedAt: at },
      { stack: { id: 's', title: 'Stack', keys: ['review:acme/web#7'] } },
    ];
    const items = states.map((over, index) => ({ ...item(over), id: `review:acme/web#${index}` }));
    expect(() =>
      validateWatchPresentation(
        {
          version: 2,
          source: GITHUB_SOURCE,
          items,
          title: 'Review requests',
          summary: '',
          label: 'Review requests',
          tone: 'neutral',
          worker: { steps: [] },
          helm: { steps: [] },
          rows: [],
          links: [],
          actions: reviewEffectActions,
          attention: [],
        },
        2,
      ),
    ).not.toThrow();
  });
});
