import { afterEach, expect, it } from 'vitest';
import type { GlassFullSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { emptyFleet, NOW } from './fixtures/glass-snapshots.js';

const pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
});

/** One grounds with a recent pass, so only a person's explicit request makes another due. */
function fleet(): GlassFullSnapshot {
  return {
    ...emptyFleet(),
    focusToken: 'page-token',
    helmPasses: [{ grounds: 'home', lastPassAt: new Date(NOW - 3600_000).toISOString() }],
  };
}

for (const hash of ['#todos', '#deck']) {
  it(`${hash}: requests the pass, keeps its pending age, and restores the button after delivery`, async () => {
    const snapshot = fleet();
    let page: GlassDom;
    page = await loadGlass(GLASS_PAGE, snapshot, {
      now: NOW,
      hash,
      post: () => {
        page.serve({ ...snapshot, helmPasses: [{ ...snapshot.helmPasses![0]!, requestedAt: new Date(NOW).toISOString() }] });
        return { status: 200, body: { ok: true } };
      },
    });
    pages.push(page);
    const button = page.$('.helm-recheck') as HTMLButtonElement;
    expect(button.textContent).toBe('Recheck all');
    expect(button.title).toBe('Asks the helm to go through every todo and goal now');
    button.click();
    await page.settle();
    const sent = page.posts().find((post) => post.url === '/requests')!;
    expect(JSON.parse(sent.body)).toEqual({ kind: 'helm-pass-request', payload: { grounds: 'home' } });
    expect(sent.headers['x-lobstah-token']).toBe('page-token');
    expect(button.textContent).toMatch(/^Asked .* ago$/);
    expect(button.disabled).toBe(true);
    button.click();
    await page.settle();
    expect(page.posts().filter((post) => post.url === '/requests')).toHaveLength(1);
    page.serve({ ...snapshot, helmPasses: [{ grounds: 'home', lastPassAt: new Date(NOW).toISOString() }] });
    await page.poll();
    expect(button.textContent).toBe('Recheck all');
    expect(button.disabled).toBe(false);
  });
}

it('shows a refusal and keeps Recheck all available for a retry', async () => {
  const page = await loadGlass(GLASS_PAGE, fleet(), {
    now: NOW,
    hash: '#todos',
    post: () => ({ status: 403, body: { ok: false, reason: 'The request was refused.' } }),
  });
  pages.push(page);
  (page.$('.helm-recheck') as HTMLButtonElement).click();
  await page.settle();
  expect(page.$('[role="alert"]')?.textContent).toBe('The request was refused.');
  expect((page.$('.helm-recheck') as HTMLButtonElement).disabled).toBe(false);
});

it('keeps a grounds with no todos available for a goals pass, and targets that grounds alone', async () => {
  const snapshot = fleet();
  snapshot.helmPasses = [{ grounds: 'alpha' }, { grounds: 'beta' }];
  const page = await loadGlass(GLASS_PAGE, snapshot, { now: NOW, hash: '#todos', post: () => ({ status: 200, body: { ok: true } }) });
  pages.push(page);
  const beta = page.$$('.todo-pass').find((row) => row.textContent?.startsWith('beta'))!;
  (beta.querySelector('button') as HTMLButtonElement).click();
  await page.settle();
  expect(JSON.parse(page.posts().find((post) => post.url === '/requests')!.body)).toEqual({
    kind: 'helm-pass-request',
    payload: { grounds: 'beta' },
  });
});
