import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { FIXTURES, NOW } from './fixtures/glass-snapshots.js';
import { RUN_KEY, runCardFleet } from './fixtures/run-card.js';
import { WHARF_CAPABILITIES } from '../../../packages/glass-ui/ui/backends/wharf.js';
import { MIRROR_CAPABILITIES } from '../../../packages/glass-ui/ui/backends/mirror.js';
import { GLASS_ACTIONS } from '../../../packages/glass-ui/ui/backend.js';
import { mirrorWriteAllowed } from '@lobstah/core';

/**
 * A glass shows only what its source can fill and do (GlassBackend's
 * capabilities). The same UI runs twice on the same fleet: once as the local
 * page, with every capability, and once on a source that fills five tabs and
 * takes no optional action. Each check first sees the control on the local
 * page, so a missing control on the narrow one is the gate, not an empty fixture.
 */

let limited = '';
beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/glass-limited-entry.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    loader: { '.png': 'dataurl' },
    logLevel: 'silent',
  });
  const script = result.outputFiles[0]!.text.replace(/<\/(script)/gi, '<\\/$1');
  const at = GLASS_PAGE.indexOf('<script>');
  const end = GLASS_PAGE.indexOf('</script>', at);
  expect(at).toBeGreaterThan(0);
  limited = GLASS_PAGE.slice(0, at) + '<script>' + script + GLASS_PAGE.slice(end);
});

const pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.map((g) => g.close()));
  pages.length = 0;
});

/** The local page and the narrow one, on the same fleet at the same hash. */
async function both(hash: string): Promise<{ local: GlassDom; narrow: GlassDom }> {
  // On the trap's machine, with a page token: the viewer the focus button needs.
  const fleet = () => ({
    ...FIXTURES['every-attention']!(),
    viewer: { onMachine: true, windowFocus: true, machine: 'studio', device: 'desktop' as const },
    focusToken: 'fixture-token',
  });
  const local = await loadGlass(GLASS_PAGE, fleet(), { now: NOW, hash });
  const narrow = await loadGlass(limited, fleet(), { now: NOW, hash });
  pages.push(local, narrow);
  return { local, narrow };
}

const tabsOf = (g: GlassDom) => g.$$('#tabs a').map((a) => a.getAttribute('data-tab'));

describe('a glass shows only what its source can fill and do', () => {
  it('lists only the tabs its source fills', async () => {
    const { local, narrow } = await both('#deck');
    expect(tabsOf(local)).toContain('prs');
    expect(tabsOf(narrow)).toEqual(['deck', 'dispatches', 'traps', 'reports', 'reviews']);
  });

  it('opens the deck for a tab its source does not fill', async () => {
    const { local, narrow } = await both('#prs');
    expect(local.$('#tabs a[data-tab="prs"]')?.className).toBe('on');
    expect(narrow.$('#tabs a[data-tab="deck"]')?.className).toBe('on');
    expect(narrow.$('#page-prs')).toBeNull();
  });

  it('offers no window focus or new trap without those actions', async () => {
    const { local, narrow } = await both('#traps');
    expect(local.$('#traps button.btn.open')).not.toBeNull();
    expect(local.$('#traps .newtrap')).not.toBeNull();
    expect(narrow.$$('#traps tr').length).toBe(local.$$('#traps tr').length);
    expect(narrow.$('#traps button.btn.open')).toBeNull();
    expect(narrow.$('#traps .newtrap')).toBeNull();
  });

  it('shows Settings (this device and view) everywhere, and helm chat only on Configuration, as a value', async () => {
    const { local, narrow } = await both('#deck');
    for (const g of [local, narrow]) {
      (g.$('#gearbtn') as HTMLElement).click();
      await g.settle();
      expect(g.$$('.settings-dialog .settings .seg button')).toHaveLength(4);
      expect(g.$('.settings-dialog [data-helm-chat]')).toBeNull();
    }
    await local.go('#settings');
    expect(local.$('#settings [data-helm-chat]')?.textContent).toContain('full');
    expect(local.$$('[data-helm-chat] input, [data-helm-chat] button, [data-helm-chat] select')).toEqual([]);
  });
  it('shows a run card with no Run button where its source runs nothing, as the wharf does', async () => {
    expect(WHARF_CAPABILITIES.actions.has('run')).toBe(false);
    const hash = `#decision/${encodeURIComponent(RUN_KEY)}`;
    const local = await loadGlass(GLASS_PAGE, runCardFleet(), { now: NOW, hash });
    const narrow = await loadGlass(limited, runCardFleet(), { now: NOW, hash });
    pages.push(local, narrow);
    expect(local.$('#doverlay .runbtn')).not.toBeNull();
    expect(narrow.$('#doverlay .runscript')).not.toBeNull();
    expect(narrow.$('#doverlay .runbtn')).toBeNull();
  });
  it('offers review actions but no settings actions on any glass', () => {
    expect([...GLASS_ACTIONS]).not.toContain('review-settings');
    expect([...GLASS_ACTIONS]).not.toContain('helm-chat');
    expect(MIRROR_CAPABILITIES.actions.has('review-request')).toBe(true);
    for (const kind of ['review-mode', 'helm-chat']) expect(mirrorWriteAllowed(kind), kind).toBe(false);
  });
  it('relays Merge when green to a mirror boat, which checks the PR is yours', () => {
    expect(mirrorWriteAllowed('pr-merge')).toBe(true);
    expect(MIRROR_CAPABILITIES.actions.has('pr-merge')).toBe(true);
  });
  it("runs a card from the local glass or a mirror boat's hosted glass, where the boat checks a phone's passkey", () => {
    expect(WHARF_CAPABILITIES.actions.has('run')).toBe(false);
    expect(MIRROR_CAPABILITIES.actions.has('run')).toBe(true);
    for (const kind of ['run-challenge', 'run', 'run-output', 'run-line', 'run-stop', 'run-dismiss', 'run-pair-challenge', 'run-pair-register']) expect(mirrorWriteAllowed(kind), kind).toBe(true);
    // The Mac's own passkey never goes through the relay.
    for (const kind of ['run-passkey-challenge', 'run-passkey-register']) expect(mirrorWriteAllowed(kind), kind).toBe(false);
  });
});
