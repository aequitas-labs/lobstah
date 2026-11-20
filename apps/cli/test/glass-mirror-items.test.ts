import { describe, expect, it } from 'vitest';
import { GITHUB_SOURCE, reviewWatchItem } from '@lobstah/core';
import type { GlassReview, GlassSnapshot, GlassViewer, WatchInventoryRow, WatchSurfaceItem } from '@lobstah/core';
import { mergeMirror, MIRROR_STALE_MS } from '../../../packages/glass-ui/ui/mirror-merge.js';
import type { MirrorBoatSnapshot } from '../../../packages/glass-ui/ui/mirror-merge.js';
import { NOW, emptyFleet } from './fixtures/glass-snapshots.js';

const viewer = { onMachine: false } as GlassViewer;
const review = (n: number): GlassReview => ({
  key: `review:acme/web#${n}`,
  url: `https://github.com/acme/web/pull/${n}`,
  reviewUrl: `https://github.com/acme/web/pull/${n}`,
  repo: 'acme/web',
  number: n,
  title: `pr ${n}`,
  author: 'dana',
  requestedBy: 'maya',
  requestedAt: new Date(NOW - 60_000).toISOString(),
  state: 'requested',
  stands: true,
  headSha: 'a',
  prHeadSha: 'a',
});
const item = (n: number): WatchSurfaceItem => ({
  watch: { key: 'review-requests:maya', generation: 'g', type: 'review-requests', status: 'watching' },
  source: GITHUB_SOURCE,
  item: reviewWatchItem(review(n), { canDraft: true, publish: false }),
});
const row = (key: string): WatchInventoryRow => ({
  key,
  generation: 'g',
  type: 'review-requests',
  status: 'watching',
  owner: { kind: 'helm', id: 'home', grounds: 'home', name: 'home helm' },
  source: GITHUB_SOURCE,
  title: 'Review requests',
  subtitle: '',
  derived: false,
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  next: { state: 'due' },
  health: 'healthy',
  links: [],
});
const boat = (id: string, name: string, ageMs: number, snapshot: Partial<GlassSnapshot>): MirrorBoatSnapshot => ({
  boat: id,
  name,
  at: new Date(NOW - ageMs).toISOString(),
  etag: id,
  snapshot: { ...emptyFleet(), ...snapshot } as GlassSnapshot,
});

describe('review items across mirror boats', () => {
  it('shows a review two boats report once, pinned to the freshest awake boat', () => {
    const north = boat('b-north', 'north', 30_000, { reviews: [review(7)], reviewItems: [item(7)] });
    const south = boat('b-south', 'south', 5_000, { reviews: [review(7), review(8)], reviewItems: [item(7), item(8)] });
    const { snapshot, router } = mergeMirror([north, south], NOW, viewer);
    expect(snapshot.reviewItems?.map((entry) => entry.item.id)).toEqual(['review:acme/web#7', 'review:acme/web#8']);
    const seven = snapshot.reviewItems![0]!;
    // The same review key names both boats; the pin decides, and never reaches the boat.
    const payload = { watch: seven.watch.key, item: seven.item.id, control: 'mute', origin: seven.origin };
    expect(router.resolve({ watch: seven.watch.key, item: seven.item.id }).ambiguous).toBe(true);
    expect(router.resolve(payload)).toEqual({ boat: 'b-south', value: { watch: seven.watch.key, item: seven.item.id, control: 'mute' } });
    // Equal freshness falls back to the lower boat ID, so the choice is stable.
    const tie = mergeMirror([boat('b-2', 'two', 5_000, { reviewItems: [item(7)] }), boat('b-1', 'one', 5_000, { reviewItems: [item(7)] })], NOW, viewer);
    expect(tie.router.resolve({ origin: tie.snapshot.reviewItems![0]!.origin }).boat).toBe('b-1');
  });

  it('prefers an awake origin and disables the actions of an item only an asleep boat has', () => {
    const asleep = boat('b-north', 'north', MIRROR_STALE_MS + 60_000, { reviewItems: [item(7), item(9)] });
    const awake = boat('b-south', 'south', 5_000, { reviewItems: [item(7)] });
    const { snapshot, router } = mergeMirror([asleep, awake], NOW, viewer);
    const byId = Object.fromEntries(snapshot.reviewItems!.map((entry) => [entry.item.id, entry]));
    expect(router.resolve({ origin: byId['review:acme/web#7']!.origin }).boat).toBe('b-south');
    expect(byId['review:acme/web#7']!.originAsleep).toBeUndefined();
    expect(byId['review:acme/web#9']!.originAsleep).toBe('north');
  });

  it('falls back to the legacy records and names an older boat that sends none', () => {
    const newer = boat('b-north', 'north', 5_000, { reviews: [review(7)], reviewItems: [item(7)] });
    const older = boat('b-south', 'south', 5_000, { reviews: [review(8)], prs: [{ key: 'pr:acme/web#8', url: 'https://github.com/acme/web/pull/8' } as never] });
    const { snapshot } = mergeMirror([newer, older], NOW, viewer);
    expect(snapshot.reviewItems).toBeUndefined();
    expect(snapshot.reviewFallback).toEqual(['south']);
    expect(snapshot.reviews?.map((r) => r.key)).toEqual(['review:acme/web#7', 'review:acme/web#8']);
    expect(snapshot.prs).toHaveLength(1);
    // A boat with no reviews at all is no reason to fall back.
    const quiet = mergeMirror([newer, boat('b-south', 'south', 5_000, {})], NOW, viewer);
    expect(quiet.snapshot.reviewItems).toHaveLength(1);
    expect(quiet.snapshot.reviewFallback).toBeUndefined();
  });

  it('keeps one Watches row per watch and boat, and source health per boat', () => {
    const north = boat('b-north', 'north', 5_000, { watchInventory: [row('review-requests:maya')], reviewSources: [{ watch: item(7).watch, source: GITHUB_SOURCE, health: 'healthy' }] });
    const south = boat('b-south', 'south', 5_000, { watchInventory: [row('review-requests:maya')], reviewSources: [{ watch: item(7).watch, source: GITHUB_SOURCE, health: 'stale', message: 'down' }] });
    const { snapshot } = mergeMirror([north, south], NOW, viewer);
    expect(snapshot.watchInventory?.map((entry) => [entry.key, entry.boat])).toEqual([
      ['review-requests:maya', 'north'],
      ['review-requests:maya', 'south'],
    ]);
    expect(snapshot.reviewSources?.map((entry) => [entry.health, entry.boat])).toEqual([
      ['healthy', 'north'],
      ['stale', 'south'],
    ]);
    // One boat's snapshot is shown as that boat's glass shows it.
    expect(mergeMirror([north], NOW, viewer).snapshot.watchInventory?.[0]?.boat).toBeUndefined();
  });
});
