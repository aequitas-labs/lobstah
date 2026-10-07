import { afterEach, describe, expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet } from './fixtures/glass-snapshots.js';
let g: GlassDom | undefined;
afterEach(async () => { await g?.close(); g = undefined; });
describe('worker metadata in the glass', () => {
  for (const view of ['cards', 'table']) {
    it(`shows current helm, trap and headless metadata in ${view} and detail`, async () => {
      const d = acceptanceFleet();
      Object.assign(d.helms[0]!, { harness: 'claude', model: 'claude-sonnet-4-6', config: { effort: null, permissionMode: 'plan' } });
      Object.assign(d.traps[0]!, { harness: 'codex', model: 'my-model', config: { effort: null, permissionMode: 'acceptEdits' } });
      d.dispatches[0]!.worker = { harness: 'codex', model: 'gpt-5.4', config: { effort: 'high', permissionMode: null } };
      g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash: '#traps', prefs: { view } });
      expect(g.$('#chips')?.textContent).toContain('claude · claude-sonnet-4-6 · plan');
      expect(g.$('#traps')?.textContent).toContain('codex · my-model · acceptEdits');
      (g.$(`#traps ${view === 'cards' ? '.card' : '.rowhead'}`) as HTMLElement).click(); await g.settle();
      expect(g.$('#modalbox')?.textContent).toContain('codex · my-model · acceptEdits');
      g.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Escape' })); await g.settle();
      await g.go('#dispatches');
      expect(g.$('#dispatches')?.textContent).toContain('codex · gpt-5.4 · high');
      (g.$(`#dispatches ${view === 'cards' ? '.card' : '.rowhead'}`) as HTMLElement).click(); await g.settle();
      expect(g.$('#modalbox')?.textContent).toContain('codex · gpt-5.4 · high');
    });
  }
});
