import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseSettingsAssignment,
  readSettings,
  settingsPath,
  settingsStored,
  validateSettingsPatch,
  writeSettings,
} from '../src/settings.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-settings-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('settings document', () => {
  it('reads defaults when the file is missing', () => {
    expect(settingsStored()).toBe(false);
    expect(readSettings()).toEqual({ glass: { view: 'table', pet: true } });
  });

  it('reads defaults when the file is malformed', () => {
    fs.writeFileSync(settingsPath(), '{not json');
    expect(readSettings()).toEqual({ glass: { view: 'table', pet: true } });
    fs.writeFileSync(settingsPath(), JSON.stringify({ glass: { view: 'grid', pet: 'nope' } }));
    expect(readSettings()).toEqual({ glass: { view: 'table', pet: true } });
    fs.writeFileSync(settingsPath(), '[]');
    expect(readSettings()).toEqual({ glass: { view: 'table', pet: true } });
  });

  it('keeps a good key when its sibling is malformed', () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ glass: { view: 'cards', pet: 3 } }));
    expect(readSettings()).toEqual({ glass: { view: 'cards', pet: true } });
  });

  it('atomic write round-trips and merges partial patches', () => {
    expect(writeSettings({ glass: { view: 'cards' } })).toEqual({ glass: { view: 'cards', pet: true } });
    expect(writeSettings({ glass: { pet: false } })).toEqual({ glass: { view: 'cards', pet: false } });
    expect(readSettings()).toEqual({ glass: { view: 'cards', pet: false } });
    expect(settingsStored()).toBe(true);
    // temp file renamed away — only the document remains
    expect(fs.readdirSync(home)).toEqual(['settings.json']);
  });
});

describe('validateSettingsPatch', () => {
  it('accepts exactly the two keys and their values', () => {
    expect(validateSettingsPatch({ glass: { view: 'cards', pet: false } })).toEqual({
      ok: true,
      patch: { glass: { view: 'cards', pet: false } },
    });
    expect(validateSettingsPatch({})).toEqual({ ok: true, patch: {} });
  });

  it('rejects unknown keys and bad values', () => {
    for (const bad of [
      null,
      [],
      'cards',
      { theme: 'dark' },
      { glass: { view: 'cards', density: 'compact' } },
      { glass: { pet: true, speed: 3 } },
      { pet: { enabled: false } },
      { pet: true },
      { glass: { view: 'grid' } },
      { glass: 'cards' },
      { glass: { pet: 'false' } },
      { glass: { pet: 1 } },
    ]) {
      expect(validateSettingsPatch(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('parses CLI assignments for the two keys only', () => {
    expect(parseSettingsAssignment('glass.pet', 'false')).toEqual({ ok: true, patch: { glass: { pet: false } } });
    expect(parseSettingsAssignment('glass.pet', 'on')).toEqual({ ok: true, patch: { glass: { pet: true } } });
    expect(parseSettingsAssignment('glass.view', 'cards')).toEqual({ ok: true, patch: { glass: { view: 'cards' } } });
    expect(parseSettingsAssignment('glass.pet', 'maybe').ok).toBe(false);
    expect(parseSettingsAssignment('pet.enabled', 'false').ok).toBe(false);
    expect(parseSettingsAssignment('glass.theme', 'dark').ok).toBe(false);
  });
});
