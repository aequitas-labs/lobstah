import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { emptyFleet, NOW } from './fixtures/glass-snapshots.js';

let home: string;
let glass: GlassDom | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-newtrap-style-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(async () => {
  await glass?.close();
  glass = undefined;
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('New trap dropdown styling', () => {
  for (const tab of ['deck', 'traps']) {
    it(`${tab}: shares the filter controls' theme and keeps Cancel working`, async () => {
      glass = await loadGlass(GLASS_PAGE, { ...emptyFleet(), repoKeys: ['web'] }, { now: NOW, hash: `#${tab}` });
      (glass.$(`#${tab} .newtrap button`) as HTMLElement).click();
      await glass.settle();
      const selects = glass.$$(`#${tab} form.newtrap select`);
      expect(selects).toHaveLength(2);
      const reference = glass.window.getComputedStyle(glass.$('.controls select') as never);
      for (const select of selects) {
        const style = glass.window.getComputedStyle(select as never);
        for (const prop of ['background-color', 'border-top-color', 'border-top-width', 'border-radius', 'color', 'font-family', 'padding-top', 'padding-right']) {
          expect(style.getPropertyValue(prop), prop).toBe(reference.getPropertyValue(prop));
        }
        expect(style.backgroundColor).not.toBe('');
        expect(style.padding).toBe('4px 8px');
      }
      const buttons = glass.$$(`#${tab} form.newtrap button`);
      expect(buttons.map((b) => b.textContent)).toEqual(['Request', 'Cancel']);
      expect(buttons[0]?.hasAttribute('disabled')).toBe(false);
      (buttons[1] as HTMLElement).click();
      await glass.settle();
      expect(glass.$(`#${tab} form.newtrap`)).toBeNull();
      expect(glass.$(`#${tab} .newtrap button`)?.textContent).toBe('+ New trap');
    });
  }
});
