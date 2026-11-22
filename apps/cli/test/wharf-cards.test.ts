import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, readReview, writeReview } from '@lobstah/core';
import type { Config, DecisionMeta, Notice, TendAttention } from '@lobstah/core';
import { boatCards, BOAT_CARDS_MAX, CARDS_RESTATE_MS, CARDS_RETRY_MS } from '../src/wharf-cards.js';
import { boatCardInput } from '../../../services/wharf/src/cards.js';
import { draftReview, pushAfterDraft, REVIEW_KEY, reviewShown } from './review-draft.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const at = new Date(NOW - 60_000).toISOString();
const cfg = {
  repos: { local: { path: '/x/local' }, remote: { path: '/x/remote', origin: 'git@github.com:test/remote.git' } },
  grounds: { home: { repos: ['local'] }, away: { repos: ['remote'], wharf: 'cloud' } },
  wharves: { cloud: { kind: 'wharf', url: 'https://wharf.invalid', account: 'person', tokenEnv: 'LOBSTAH_TEST_CARDS_TOKEN' } },
} as unknown as Config;
const item = (a: Partial<TendAttention> & Pick<TendAttention, 'kind' | 'key'>): TendAttention => ({ stateHash: 'h', id: a.key, lane: 'work', verb: a.kind, ageSecs: 60, at, ...a });
const permission: DecisionMeta = {
  key: 'decision:grant1', title: 'Allow git push', options: ['Allow once', 'Allow always', 'No'], optionNotes: { 'Allow always': 'git push in every lobstah checkout' },
  attachments: [], detailBytes: 0, repo: 'remote', askedBy: 'worker', askedAt: at, stateHash: 'p1',
  permission: { command: 'git push origin HEAD', harness: 'claude', trap: 'early-pebble' },
};
const localAsk: DecisionMeta = { ...permission, key: 'decision:local', title: 'Pick a name', options: ['A', 'B'], repo: 'local', permission: undefined };
const notice = (seq: string, repo?: string): Notice => ({ seq, kind: 'trap-stowed', at, text: `trap stowed ${seq}`, ...(repo ? { repo } : {}) });

it('only cards of repos in a grounds bound to a wharf leave the boat, and each passes the wharf’s own checks', () => {
  const attention = [
    item({ kind: 'decision', key: permission.key, note: permission.title, repo: 'remote' }),
    item({ kind: 'decision', key: localAsk.key, note: localAsk.title, repo: 'local' }),
    item({ kind: 'pr:ready', key: 'pr:github.com/test/remote#7', note: 'Ready to merge', repo: 'remote', prUrl: 'https://github.com/test/remote/pull/7' }),
    item({ kind: 'watch', key: 'watch:w1', note: 'watch held', repo: 'remote', acked: { at, by: 'pet' } }),
    // The wharf's own items are its cards already.
    item({ kind: 'landed', key: `work:srv-${'a'.repeat(40)}`, repo: 'remote', wharf: 'cloud', grounds: 'away' }),
    item({ kind: 'pr:ready', key: 'pr:github.com/test/local#9', repo: 'local', prUrl: 'https://github.com/test/local/pull/9' }),
    // A PR with no local dispatch names its GitHub repo; the configured origin places it.
    item({ kind: 'pr:checks', key: 'pr:github.com/test/remote#8', repo: 'test/remote', prUrl: 'https://github.com/test/remote/pull/8' }),
  ];
  const sets = boatCards(cfg, attention, [permission, localAsk], [notice('n1', 'remote'), notice('n2', 'local'), notice('n3')], NOW);
  expect(sets.map((s) => s.wharf)).toEqual(['cloud']);
  const cards = sets[0]!.cards;
  expect(cards.map((c) => `${c.family}:${c.key}`).sort()).toEqual(['notice:notice:n1', 'notice:watch:w1', 'permission:decision:grant1', 'pr:pr:github.com/test/remote#7', 'pr:pr:github.com/test/remote#8']);
  expect(cards.find((c) => c.family === 'permission')).toMatchObject({
    grounds: 'away', title: 'Allow git push', actions: [{ kind: 'allow-once' }, { kind: 'allow-always' }, { kind: 'deny' }],
    summary: 'Run: git push origin HEAD\ntrap early-pebble · claude · remote\nAllow always: git push in every lobstah checkout',
  });
  expect(cards.find((c) => c.family === 'pr')).toMatchObject({ links: [{ label: 'Open PR', url: 'https://github.com/test/remote/pull/7' }], actions: [{ kind: 'seen' }] });
  expect(cards.find((c) => c.key === 'watch:w1')).toMatchObject({ seen: { by: 'pet' }, actions: [] });
  // What the boat sends is what the wharf accepts, field for field.
  for (const card of cards) expect(boatCardInput(JSON.parse(JSON.stringify(card)))).toEqual(card);
  expect(JSON.stringify(sets)).not.toContain('Pick a name');
});

it('a mirrored local grounds’ cards join the wharf grounds’ set on the mirror’s wharf; an unmirrored one’s stay here', () => {
  const attention = [
    item({ kind: 'decision', key: permission.key, note: permission.title, repo: 'remote' }),
    item({ kind: 'decision', key: localAsk.key, note: localAsk.title, repo: 'local' }),
  ];
  const mirrored = { ...cfg, glass: { port: 4949, mirror: 'cloud' } } as Config;
  const sets = boatCards(mirrored, attention, [permission, localAsk], [notice('n2', 'local')], NOW);
  expect(sets.map((s) => s.wharf)).toEqual(['cloud']);
  expect(sets[0]!.cards.map((c) => `${c.grounds}:${c.key}`).sort()).toEqual(['away:decision:grant1', 'home:decision:local', 'home:notice:n2']);
  expect(boatCards(cfg, attention, [permission, localAsk], [notice('n2', 'local')], NOW)[0]!.cards.map((c) => c.grounds)).toEqual(['away']);
  // The implicit home is `fleet` on disk: a helm's question with no repo still finds it.
  const implicit = { repos: cfg.repos, grounds: {}, wharves: cfg.wharves, glass: { port: 4949, mirror: 'cloud' } } as unknown as Config;
  const helmAsk: DecisionMeta = { ...localAsk, key: 'decision:helm', repo: undefined, grounds: 'fleet' };
  const [home] = boatCards(implicit, [item({ kind: 'decision', key: helmAsk.key, note: helmAsk.title })], [helmAsk], [], NOW);
  expect(home!.cards).toEqual([expect.objectContaining({ key: 'decision:helm', grounds: 'home' })]);
});

it('a set over the wharf’s limit keeps what asks for attention first', () => {
  const attention = Array.from({ length: BOAT_CARDS_MAX + 20 }, (_, i) =>
    item({ kind: 'dispatch-progress', key: `progress:work:${i}`, repo: 'remote', quiet: true, at: new Date(NOW - i * 1000).toISOString() }));
  attention.push(item({ kind: 'decision', key: permission.key, repo: 'remote', at: new Date(NOW - 3_600_000).toISOString() }));
  const cards = boatCards(cfg, attention, [permission], [], NOW)[0]!.cards;
  expect(cards).toHaveLength(BOAT_CARDS_MAX);
  expect(cards[0]).toMatchObject({ family: 'permission' });
});

describe('a review card', () => {
  const mirrored = { ...cfg, repos: { ...cfg.repos, web: { path: '/x/web' } }, grounds: { ...cfg.grounds, home: { repos: ['local', 'web'] } }, glass: { port: 4949, mirror: 'cloud' } } as Config;
  const reviewCard = () => boatCards(mirrored, reviewShown(), [], [], NOW)[0]!.cards.find((c) => c.family === 'review')!;

  it('with a drafted round offers Submit review with its verdict and PR, and says what it posts', () => {
    draftReview('request_changes');
    const card = reviewCard();
    expect(card).toMatchObject({ grounds: 'home', key: REVIEW_KEY, links: [{ label: 'Open PR', url: 'https://github.com/acme/web/pull/42' }] });
    expect(card.actions).toEqual([{ kind: 'review-submit', event: 'REQUEST_CHANGES', pr: 42 }, { kind: 'seen' }]);
    expect(card.summary).toBe('Ready to post: Request changes · 2 comments\n\nThe retry loop reads well.\nOne blocker: a retry can charge twice.\nDetails inline.');
    // What the boat sends is what the wharf accepts, field for field.
    expect(boatCardInput(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });

  it('offers Approve only while the draft’s verdict is approve', () => {
    for (const verdict of ['request_changes', 'comment'] as const) {
      draftReview(verdict);
      expect(reviewCard().actions!.filter((a) => a.kind === 'review-approve')).toEqual([]);
    }
    draftReview('approve');
    expect(reviewCard().actions).toEqual([{ kind: 'review-submit', event: 'APPROVE', pr: 42 }, { kind: 'review-approve', pr: 42 }, { kind: 'seen' }]);
    expect(reviewCard().summary).toBe('Ready to post: Approve · no comments');
  });

  it('offers no post once the round is posted or the PR moved past its draft', () => {
    draftReview('approve');
    pushAfterDraft();
    expect(reviewCard().actions).toEqual([{ kind: 'seen' }]);
    draftReview('approve');
    const item = readReview(REVIEW_KEY)!;
    item.rounds[0]!.state = 'posted';
    writeReview(item);
    expect(reviewCard().actions).toEqual([{ kind: 'seen' }]);
  });
});

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cards-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `
[repos.remote]
path = '${home.replaceAll('\\', '/')}'
[wharves.cloud]
url = 'https://wharf.invalid'
account = 'person'
tokenEnv = 'LOBSTAH_TEST_CARDS_TOKEN'
[grounds.away]
repos = ['remote']
wharf = 'cloud'
`);
  process.env.LOBSTAH_TEST_CARDS_TOKEN = 'b.person.boat.secretsecretsecret';
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); delete process.env.LOBSTAH_HOME; delete process.env.LOBSTAH_TEST_CARDS_TOKEN; removeTempDir(home); });

it('the daemon restates a changed set, an unchanged one only now and then, and waits a minute after a failure', async () => {
  const posts: Array<{ url: string; key: string | null; body: { cards: unknown[] } }> = [];
  let fail = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer b.person.boat.secretsecretsecret');
    // The boat asks for answers to its cards each check; none wait here.
    if (url.endsWith('/cards/answers')) return Response.json([]);
    posts.push({ url, key: headers.get('Idempotency-Key'), body: JSON.parse(String(init.body)) });
    return fail ? Response.json({ error: 'route not found' }, { status: 404 }) : Response.json({ changed: 0 });
  }));
  const { publishBoatCards } = await import('../src/wharf-cards.js');
  await publishBoatCards(NOW);
  expect(posts).toHaveLength(1);
  // An empty set is still stated: it ends what the wharf showed for this boat.
  expect(posts[0]).toMatchObject({ url: 'https://wharf.invalid/v1/accounts/person/cards', body: { cards: [] } });
  expect(posts[0]!.key).toMatch(/^cards-/);
  await publishBoatCards(NOW + 5_000); await publishBoatCards(NOW + 20_000);
  expect(posts).toHaveLength(1);
  await publishBoatCards(NOW + CARDS_RESTATE_MS + 1_000);
  expect(posts).toHaveLength(2);
  fail = true;
  await publishBoatCards(NOW + 2 * CARDS_RESTATE_MS + 2_000);
  await publishBoatCards(NOW + 2 * CARDS_RESTATE_MS + 20_000);
  expect(posts).toHaveLength(3);
  fail = false;
  await publishBoatCards(NOW + 2 * CARDS_RESTATE_MS + 2_000 + CARDS_RETRY_MS + 15_000);
  expect(posts).toHaveLength(4);
});

it('with reviews on, a mirrored grounds’ drafted review is restated as its card', async () => {
  fs.writeFileSync(path.join(home, 'config.toml'), `
[repos.web]
path = '${home.replaceAll('\\', '/')}'
[wharves.cloud]
url = 'https://wharf.invalid'
account = 'person'
tokenEnv = 'LOBSTAH_TEST_CARDS_TOKEN'
[glass]
mirror = 'cloud'
[reviews]
enabled = true
`);
  draftReview('approve');
  const item = readReview(REVIEW_KEY)!;
  item.rounds[0]!.notification = { kind: 'needs-you', at: new Date(NOW - 60_000).toISOString(), text: 'Draft ready (needs you): acme/web#42 · approve · 0 blocking' };
  writeReview(item);
  const posts: Array<{ cards: Array<{ family: string; actions: unknown[] }> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/cards/answers')) return Response.json([]);
    posts.push(JSON.parse(String(init.body)));
    return Response.json({ changed: 1 });
  }));
  const { publishBoatCards } = await import('../src/wharf-cards.js');
  await publishBoatCards(NOW);
  expect(posts[0]!.cards.find((c) => c.family === 'review')).toMatchObject({ grounds: 'home', title: 'Draft ready (needs you): acme/web#42 · approve · 0 blocking', actions: [{ kind: 'review-submit' }, { kind: 'review-approve' }, { kind: 'seen' }] });
});
