import { afterEach, describe, expect, it } from 'vitest';
import type { GlassPrDetails, GlassReview } from '@lobstah/core';
import { mirrorReadAllowed } from '../../../packages/core/src/backend-model.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass, type GlassDom } from './glass-dom.js';
import { acceptanceFleet, emptyFleet, NOW, ago } from './fixtures/glass-snapshots.js';
import { REVIEW_DECISIONS } from '../../../test/review-decisions.js';

const key = 'pr:acme/web#7';
const draft: GlassReview = {
  key: 'review:acme/web#7', repo: 'acme/web', number: 7, title: 'Keep the full review',
  url: 'https://github.com/acme/web/pull/7', reviewUrl: 'https://review.example/acme/web/7',
  author: 'dana', requestedBy: 'dana', asker: 'dana', askerName: 'Dana Developer',
  requestedAt: ago(60_000), state: 'drafted', stands: true, headSha: 'aaa', prHeadSha: 'aaa',
  verdict: 'request_changes', needsYou: true, summary: 'Full **summary** before the description.',
  blocking: [{ path: 'src/save.ts', line: 9, body: 'The complete blocking finding.' }],
  comments: [{ path: 'src/view.ts', line: 4, body: 'Nit: spell out the label.' }],
};
const details: GlassPrDetails = {
  key, url: draft.url, title: draft.title, bodyHtml: '<p>PR description</p>',
  headRefName: 'fix/save', baseRefName: 'main', updatedAt: ago(30_000),
};
const opened: GlassDom[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(g => g.close())); });
const text = (g: GlassDom) => g.$('.detail-frame')?.textContent ?? '';

describe('the PR view', () => {
  it.each(['approve', 'comment', 'request_changes'] as const)('saves option and free-text answers before enabling %s, and restores them on reload', async verdict => {
    let review: GlassReview = { ...draft, verdict, roundId: 'round1', draftedAt: ago(30), decisions: REVIEW_DECISIONS, seenAt: ago(10) };
    const snapshot = () => ({ ...emptyFleet(), reviews: [review], focusToken: 'tok' });
    const options = {
      now: NOW, hash: '#pr/' + encodeURIComponent(key),
      get: (url: string) => url.startsWith('/data/pr/') ? { status: 200, body: details } : undefined,
      post: (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body);
        if (request.kind === 'review-decision-answer') {
          const { decisionId, answer } = request.payload;
          review = { ...review, decisionAnswers: { ...review.decisionAnswers, [decisionId]: answer } };
          g.serve(snapshot());
        }
        return { status: 200, body: { ok: true } };
      },
    };
    const g = await loadGlass(GLASS_PAGE, snapshot(), options); opened.push(g);
    const send = () => g.$('.detail-actions .btn-primary')!;
    expect(send().hasAttribute('disabled')).toBe(true);
    expect(text(g).indexOf('Your calls')).toBeLessThan(text(g).indexOf('Findings'));
    expect(g.$$('fieldset input:checked')).toHaveLength(0);
    expect(g.$$('fieldset .badge').map(badge => badge.textContent)).toEqual(['Recommended', 'Recommended']);
    const radio = g.$('[data-review-decision="rollout-owner"] input')!;
    (radio as unknown as HTMLElement).click(); await g.settle();
    expect(send().hasAttribute('disabled')).toBe(true);
    const field = g.$('[data-review-decision="existing-users"] textarea') as unknown as HTMLTextAreaElement;
    field.value = 'Ask each user before migrating.';
    field.dispatchEvent(new g.window.Event('input', { bubbles: true }) as unknown as Event);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(send().hasAttribute('disabled')).toBe(true);
    await g.settle();
    expect(send().hasAttribute('disabled')).toBe(false);
    expect(g.posts().map(post => JSON.parse(post.body))).toEqual([
      { kind: 'review-decision-answer', payload: { key: review.key, roundId: 'round1', headSha: 'aaa', draftedAt: review.draftedAt, decisionId: 'rollout-owner', answer: { optionId: 'product' } } },
      { kind: 'review-decision-answer', payload: { key: review.key, roundId: 'round1', headSha: 'aaa', draftedAt: review.draftedAt, decisionId: 'existing-users', answer: { text: 'Ask each user before migrating.' } } },
    ]);
    const reloaded = await loadGlass(GLASS_PAGE, snapshot(), { now: NOW, hash: options.hash, get: options.get }); opened.push(reloaded);
    expect(reloaded.$$('fieldset input:checked')).toHaveLength(1);
    expect((reloaded.$('[data-review-decision="existing-users"] textarea') as unknown as HTMLTextAreaElement).value).toBe('Ask each user before migrating.');
    expect(reloaded.$('.detail-actions .btn-primary')?.hasAttribute('disabled')).toBe(false);
  });

  it('keeps posting disabled after a failed save and lets Chris retry', async () => {
    const review = { ...draft, roundId: 'round1', draftedAt: ago(30), decisions: REVIEW_DECISIONS, seenAt: ago(10) };
    let fail = true;
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviews: [review], focusToken: 'tok' }, {
      now: NOW, hash: '#pr/' + encodeURIComponent(key),
      post: () => fail ? { status: 409, body: { ok: false, reason: 'Save failed. Try again.' } } : { status: 200, body: { ok: true } },
    }); opened.push(g);
    (g.$('fieldset input') as unknown as HTMLElement).click(); await g.settle();
    expect(text(g)).toContain('Save failed. Try again.');
    expect(g.$('.detail-actions .btn-primary')?.hasAttribute('disabled')).toBe(true);
    fail = false;
    (g.$$('fieldset button').find(button => button.textContent === 'Retry save') as unknown as HTMLElement).click(); await g.settle();
    expect(g.posts()).toHaveLength(2);
    expect(text(g)).not.toContain('Save failed. Try again.');
  });

  it('offers New review in the skipped PR menu', async () => {
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviews: [{ ...draft, state: 'dismissed' }], focusToken: 'tok' }, {
      now: NOW, hash: '#pr/' + encodeURIComponent(key), post: () => ({ status: 200, body: { ok: true } }),
    }); opened.push(g);
    (g.$('.detail-actions .splitmore') as unknown as HTMLElement).click(); await g.settle();
    const action = g.$$('.detail-actions [role="menuitem"]').find(button => button.textContent?.includes('New review'))!;
    expect(action).toBeTruthy();
    (action as unknown as HTMLElement).click(); await g.settle();
    expect(g.posts().map(post => JSON.parse(post.body))).toContainEqual({ kind: 'review-new', payload: { key: draft.key } });
  });
  it('opens a review-only draft with full findings first and records it as seen', async () => {
    const reads: string[] = [];
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviews: [draft], focusToken: 'tok' }, {
      now: NOW, hash: '#reviews', prefs: { view: 'cards' },
      get: url => { if (!url.startsWith('/data/pr/')) return; reads.push(url); return { status: 200, body: details }; },
    });
    opened.push(g);
    g.setScroll(420);
    (g.$('[data-review]') as unknown as HTMLElement).click();
    await g.settle();
    expect(g.window.location.hash).toBe('#pr/pr%3Aacme%2Fweb%237');
    expect(text(g)).toContain('The complete blocking finding.');
    expect(text(g)).toContain('Nit: spell out the label.');
    expect(text(g).indexOf('Findings')).toBeLessThan(text(g).indexOf('Description'));
    expect(text(g)).toContain('Dana Developer');
    expect(text(g)).toContain('fix/save → main');
    expect(g.posts().map(post => JSON.parse(post.body))).toEqual([{ kind: 'review-seen', payload: { key: draft.key } }]);
    expect(reads).toEqual(['/data/pr/pr%3Aacme%2Fweb%237']);
    (g.$('.detail-close') as unknown as HTMLElement).click();
    await g.settle();
    expect(g.$('.detail-frame')).toBeNull();
    expect(g.window.location.hash).toBe('#reviews');
    expect(g.scrolls().at(-1)).toBe(420);
    (g.$('[data-review]') as unknown as HTMLElement).click();
    await g.settle();
    expect(reads).toHaveLength(2);
    expect(g.posts().every(post => JSON.parse(post.body).kind === 'review-seen')).toBe(true);
  });

  it('renders GitHub HTML through an allowlist and opens signed images in the lightbox', async () => {
    const signed = 'https://private-user-images.githubusercontent.com/1/image.png?jwt=fresh';
    const g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), reviews: [draft] }, {
      now: NOW, hash: '#pr/' + encodeURIComponent(key),
      get: url => url.startsWith('/data/pr/') ? { status: 200, body: { ...details,
        bodyHtml: `<h3>Description title</h3><script>window.bad = true</script><iframe src="https://evil.example"></iframe><p onclick="bad()">Safe <strong>words</strong><a href="javascript:bad()">bad link</a><a href="https://example.com">good link</a></p><img src="${signed}" onerror="bad()" alt="Preview"><img src="data:image/svg+xml,bad" alt="unsafe">`,
      } } : undefined,
    });
    opened.push(g);
    expect(g.$('.github-description script, .github-description iframe, .github-description [onclick], .github-description [onerror]')).toBeNull();
    expect(g.$$('.github-description a').map(a => a.getAttribute('href'))).toEqual(['https://example.com']);
    expect(g.$$('.github-description img').map(a => a.getAttribute('src'))).toEqual([signed]);
    expect(text(g)).toContain('Safe words');
    (g.$('.github-description .mdimg') as unknown as HTMLElement).click();
    await g.settle();
    expect(g.$('.lightbox img')?.getAttribute('src')).toBe(signed);
    expect(g.posts()).toEqual([]);
  });

  it('names failing checks and review decisions in a watched PR', async () => {
    const fleet = acceptanceFleet();
    const pr = fleet.prs[0]!;
    pr.failingChecks = [{ name: 'Typecheck', detailsUrl: 'https://github.com/acme/web/actions/runs/12' }];
    pr.checks = { total: 3, passed: 1, failed: 1, pending: 1 };
    pr.reviewDecision = 'CHANGES_REQUESTED';
    pr.review = { unresolvedThreads: 2, changesRequested: true };
    const g = await loadGlass(GLASS_PAGE, fleet, { now: NOW, hash: '#pr/' + encodeURIComponent(pr.key), get: url => url.startsWith('/data/pr/') ? { status: 404, body: {} } : undefined });
    opened.push(g);
    expect(text(g)).toContain('Typecheck');
    expect(g.$('.pr-check a')?.getAttribute('href')).toContain('/actions/runs/12');
    expect(text(g)).toContain('Changes requested · 2 unresolved threads');
    expect(text(g)).toContain('1 passed · 1 pending');
    expect(text(g)).toContain('The PR description could not be read.');
  });

  it('permits only validated PR identities through the hosted read relay', () => {
    expect(mirrorReadAllowed('/data/pr/' + encodeURIComponent(key))).toBe(true);
    for (const suffix of ['%E0%A4%A', 'pr%3Aa%2Fb%230', 'pr%3Aa%2Fb%231%3Ftoken%3Dsecret', 'pr%3A..%2Fb%231', 'pr%3Aa%2Fb%231%2Fextra']) {
      expect(mirrorReadAllowed('/data/pr/' + suffix), suffix).toBe(false);
    }
    expect(mirrorReadAllowed('/data/dispatch/a%2Fb')).toBe(false);
  });
});
