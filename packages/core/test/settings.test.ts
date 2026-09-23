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
    expect(readSettings()).toEqual({ glass: { view: 'table' }, pet: { enabled: true } });
  });

  it('reads defaults when the file is malformed', () => {
    fs.writeFileSync(settingsPath(), '{not json');
    expect(readSettings()).toEqual({ glass: { view: 'table' }, pet: { enabled: true } });
    fs.writeFileSync(settingsPath(), JSON.stringify({ glass: { view: 'grid' }, pet: { enabled: 'nope' } }));
    expect(readSettings()).toEqual({ glass: { view: 'table' }, pet: { enabled: true } });
    fs.writeFileSync(settingsPath(), '[]');
    expect(readSettings()).toEqual({ glass: { view: 'table' }, pet: { enabled: true } });
  });

  it('keeps a good key when its sibling is malformed', () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ glass: { view: 'cards' }, pet: 3 }));
    expect(readSettings()).toEqual({ glass: { view: 'cards' }, pet: { enabled: true } });
  });

  it('atomic write round-trips and merges partial patches', () => {
    expect(writeSettings({ glass: { view: 'cards' } })).toEqual({ glass: { view: 'cards' }, pet: { enabled: true } });
    expect(writeSettings({ pet: { enabled: false } })).toEqual({ glass: { view: 'cards' }, pet: { enabled: false } });
    expect(readSettings()).toEqual({ glass: { view: 'cards' }, pet: { enabled: false } });
    expect(settingsStored()).toBe(true);
    // temp file renamed away — only the document remains
    expect(fs.readdirSync(home)).toEqual(['settings.json']);
  });
});

describe('validateSettingsPatch', () => {
  it('accepts exactly the two keys and their values', () => {
    expect(validateSettingsPatch({ glass: { view: 'cards' }, pet: { enabled: false } })).toEqual({
      ok: true,
      patch: { glass: { view: 'cards' }, pet: { enabled: false } },
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
      { pet: { enabled: true, speed: 3 } },
      { glass: { view: 'grid' } },
      { glass: 'cards' },
      { pet: { enabled: 'false' } },
      { pet: { enabled: 1 } },
    ]) {
      expect(validateSettingsPatch(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('parses CLI assignments for the two keys only', () => {
    expect(parseSettingsAssignment('pet.enabled', 'false')).toEqual({ ok: true, patch: { pet: { enabled: false } } });
    expect(parseSettingsAssignment('pet.enabled', 'on')).toEqual({ ok: true, patch: { pet: { enabled: true } } });
    expect(parseSettingsAssignment('glass.view', 'cards')).toEqual({ ok: true, patch: { glass: { view: 'cards' } } });
    expect(parseSettingsAssignment('pet.enabled', 'maybe').ok).toBe(false);
    expect(parseSettingsAssignment('glass.theme', 'dark').ok).toBe(false);
  });
});
