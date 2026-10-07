import { afterEach, describe, expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet } from './fixtures/glass-snapshots.js';
let g: GlassDom | undefined;
afterEach(async () => { await g?.close(); g = undefined; });
const observedAt = new Date(NOW - 1000).toISOString();
function fixture() {
  const d = acceptanceFleet();
  Object.assign(d.helms[0]!, { harness: 'claude', model: 'claude-sonnet-4-6', config: { effort: null, permissionMode: 'plan' }, observedAt });
  Object.assign(d.traps[0]!, { harness: 'codex', model: 'my-model', config: { effort: 'high', permissionMode: 'acceptEdits' }, observedAt });
  d.dispatches[0]!.worker = { harness: 'codex', model: 'gpt-5.4', config: { effort: 'high', permissionMode: null }, observedAt };
  d.dispatches[0]!.evidence = { ...d.dispatches[0]!.evidence, harness: 'codex', worker: d.dispatches[0]!.worker };
  return d;
}
function details(values: string[]) {
  expect(g!.$$('#modalbox .worker-details')).toHaveLength(1);
  expect(g!.$$('#modalbox .worker-details dd').map(n => n.textContent)).toEqual(values);
}
async function close() {
  g!.document.dispatchEvent(new g!.window.KeyboardEvent('keydown', { key: 'Escape' }));
  await g!.settle();
}
describe('worker metadata in the glass', () => {
  for (const view of ['cards', 'table']) {
    it(`${view}: compact indicators, accessible focus tooltip, one modal details section for all roles`, async () => {
      g = await loadGlass(GLASS_PAGE, fixture(), { now: NOW, hash: '#traps', prefs: { view } });
      expect(g.$('#chips')?.textContent).not.toContain('claude-sonnet');
      expect(g.$('#traps')?.textContent).not.toContain('my-model');
      expect(g.$('#traps')?.textContent).not.toContain('acceptEdits');
      const indicator = g.$('#traps .worker-harness') as HTMLElement;
      expect(indicator.textContent?.trim()).toBe('codex');
      expect(indicator.getAttribute('aria-label')).toBe('my-model · high');
      expect(indicator.getAttribute('tabindex')).toBe('0');
      indicator.focus(); await g.settle();
      expect(g.document.activeElement).toBe(indicator);
      expect(g.$('[role="tooltip"]')?.textContent).toBe('my-model · high');
      indicator.blur(); await g.settle();
      expect(g.$('[role="tooltip"]')).toBeNull();
      indicator.dispatchEvent(new g.window.MouseEvent('mouseenter')); await g.settle();
      expect(g.$('[role="tooltip"]')?.textContent).toBe('my-model · high');
      (g.$(`#traps ${view === 'cards' ? '.card' : '.rowhead'}`) as HTMLElement).click(); await g.settle();
      details(['codex', 'my-model', 'high', 'acceptEdits', observedAt]);
      expect(g.$('[role="tooltip"]')).toBeNull();
      await close();
      (g.$('#chips .chip.click') as HTMLElement).click(); await g.settle();
      details(['claude', 'claude-sonnet-4-6', 'unknown', 'plan', observedAt]);
      await close();
      await g.go('#dispatches');
      expect(g.$('#dispatches')?.textContent).not.toContain('gpt-5.4');
      expect(g.$('#dispatches .worker-harness')?.getAttribute('aria-label')).toBe('gpt-5.4 · high');
      (g.$(`#dispatches ${view === 'cards' ? '.card' : '.rowhead'}`) as HTMLElement).click(); await g.settle();
      details(['codex', 'gpt-5.4', 'high', 'unknown', observedAt]);
      expect(g.$('#modalbox')?.textContent?.match(/gpt-5\.4/g)).toHaveLength(1);
      expect(g.$('.worker-details')?.textContent).toContain('headless worker · launch / observation');
      await close();
      await g.go('#deck');
      expect(g.$('#deck')?.textContent).not.toContain('my-model');
      expect(g.$('#deck')?.textContent).not.toContain('gpt-5.4');
      expect(g.$$('#deck .worker-harness').map(n => n.getAttribute('aria-label'))).toContain('my-model · high');
    });
  }
  it('null model says model unknown; null effort is omitted and absent observation stays unknown', async () => {
    const d = fixture();
    Object.assign(d.traps[0]!, { model: null, config: { effort: null, permissionMode: null }, observedAt: undefined });
    g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#traps', prefs: { view: 'cards' } });
    expect(g.$('#traps .worker-harness')?.getAttribute('aria-label')).toBe('model unknown');
    expect(g.$('#chips .worker-harness')?.getAttribute('aria-label')).toBe('claude-sonnet-4-6');
    (g.$('#traps .card') as HTMLElement).click(); await g.settle();
    details(['codex', 'model unknown', 'unknown', 'unknown', 'unknown']);
  });
});
