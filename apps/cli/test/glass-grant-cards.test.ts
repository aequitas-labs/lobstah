import { afterEach, expect, it } from 'vitest';
import type { Grant } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, emptyFleet } from './fixtures/glass-snapshots.js';

/** Grant cards on the shared card (components/session-grants.ts): two lines, a green edge, and a tap to see the rest. */

let g: GlassDom | undefined;
afterEach(async () => {
  await g?.close();
  g = undefined;
});

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const standing: Grant = {
  id: 'grant-standing-1',
  at: new Date(NOW - 3600_000).toISOString(),
  by: 'glass',
  harness: 'codex',
  mode: 'intent',
  repo: 'web',
  intent: { text: 'Read-only diagnosis of staging', patterns: [{ kind: 'command', pattern: 'npx wrangler tail *' }] },
  expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
  uses: 2,
  lastUsedAt: new Date(NOW - 60_000).toISOString(),
};

it('shows what a grant allows and `active` on a green edge, then its scope and time left with Revoke; a tap shows the rest', async () => {
  g = await loadGlass(GLASS_PAGE, { ...emptyFleet(), focusToken: 'tok', standingGrants: [standing] }, { now: NOW, hash: '#grants', post: () => ({ status: 200, body: { ok: true } }) });
  const card = g.$('.standing-grants .card')!;
  expect(card.className).toContain('gcard-edge gedge-ok');
  expect(text(card.querySelector('.gtitle'))).toBe('Read-only diagnosis of staging');
  expect(text(card.querySelector('.gword'))).toBe('active');
  expect(text(card.querySelector('.gcontext .gtext'))).toBe('Every trap in 📁 web · expires in 9 min');
  // Uses, harness, patterns and id wait behind a tap.
  for (const hidden of ['2 uses', 'Codex', 'npx wrangler tail', 'grant-standing-1']) expect(text(card)).not.toContain(hidden);
  // Revoke sends, and leaves the card closed.
  (card.querySelector('.gaction button') as HTMLElement).click();
  await g.settle();
  expect(g.posts().map((p) => JSON.parse(p.body))).toContainEqual({ kind: 'grant-revoke', payload: { id: standing.id } });
  expect(g.$('.standing-grants .card')!.getAttribute('aria-expanded')).toBe('false');
  (g.$('.standing-grants .card') as HTMLElement).click();
  await g.settle();
  const open = g.$('.standing-grants .card')!;
  expect(open.getAttribute('aria-expanded')).toBe('true');
  for (const shown of ['2 uses', 'Codex', 'npx wrangler tail', 'grant-standing-1']) expect(text(open.querySelector('.gmore'))).toContain(shown);
  // A click inside what it shows keeps it open.
  (open.querySelector('.gmore .grant-id') as HTMLElement).click();
  await g.settle();
  expect(g.$('.standing-grants .card')!.getAttribute('aria-expanded')).toBe('true');
});
