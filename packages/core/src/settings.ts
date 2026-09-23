import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from './paths.js';

/**
 * Runtime settings: `~/.lobstah/settings.json`. Not config.toml — these are
 * flipped at runtime by the spyglass popover, `lobstah settings set`, and
 * the pet's menu (through the CLI). Exactly two keys; the set is closed and
 * every write path validates against it.
 */

export const GLASS_VIEWS = ['table', 'cards'] as const;
export type GlassView = (typeof GLASS_VIEWS)[number];

export interface Settings {
  glass: { view: GlassView };
  pet: { enabled: boolean };
}

/** A partial document — what POST /settings and `settings set` carry. */
export interface SettingsPatch {
  glass?: { view?: GlassView };
  pet?: { enabled?: boolean };
}

/** The closed key set, dotted, as `lobstah settings set` names them. */
export const SETTINGS_KEYS = ['glass.view', 'pet.enabled'] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export function defaultSettings(): Settings {
  return { glass: { view: 'table' }, pet: { enabled: true } };
}

export function settingsPath(): string {
  return path.join(lobstahHome(), 'settings.json');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The document on disk, with defaults for anything absent or malformed. A
 * bad value falls back per key rather than discarding the whole file.
 */
export function readSettings(): Settings {
  const s = defaultSettings();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return s;
  }
  if (!isObj(raw)) return s;
  if (isObj(raw.glass) && (GLASS_VIEWS as readonly unknown[]).includes(raw.glass.view)) {
    s.glass.view = raw.glass.view as GlassView;
  }
  if (isObj(raw.pet) && typeof raw.pet.enabled === 'boolean') s.pet.enabled = raw.pet.enabled;
  return s;
}

/**
 * Validate an untrusted partial document against exactly the two keys and
 * their allowed values. Returns the patch, or an error string naming the
 * first offense — unknown keys are rejected, never ignored.
 */
export function validateSettingsPatch(input: unknown): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  if (!isObj(input)) return { ok: false, error: 'settings must be a JSON object' };
  const patch: SettingsPatch = {};
  for (const [section, body] of Object.entries(input)) {
    if (section !== 'glass' && section !== 'pet') return { ok: false, error: `unknown settings key: ${section}` };
    if (!isObj(body)) return { ok: false, error: `${section} must be an object` };
    for (const [k, v] of Object.entries(body)) {
      if (section === 'glass' && k === 'view') {
        if (!(GLASS_VIEWS as readonly unknown[]).includes(v)) {
          return { ok: false, error: `glass.view must be one of ${GLASS_VIEWS.join(' | ')}` };
        }
        patch.glass = { view: v as GlassView };
      } else if (section === 'pet' && k === 'enabled') {
        if (typeof v !== 'boolean') return { ok: false, error: 'pet.enabled must be true or false' };
        patch.pet = { enabled: v };
      } else {
        return { ok: false, error: `unknown settings key: ${section}.${k}` };
      }
    }
  }
  return { ok: true, patch };
}

/** Parse a CLI `settings set <key> <value>` pair into a validated patch. */
export function parseSettingsAssignment(key: string, value: string): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  if (key === 'glass.view') return validateSettingsPatch({ glass: { view: value } });
  if (key === 'pet.enabled') {
    const b = value === 'true' || value === 'on' ? true : value === 'false' || value === 'off' ? false : value;
    return validateSettingsPatch({ pet: { enabled: b } });
  }
  return { ok: false, error: `unknown settings key: ${key} (one of ${SETTINGS_KEYS.join(', ')})` };
}

/**
 * The one write path: merge a validated patch over what is on disk, write
 * atomically (temp file + rename), return the new document.
 */
export function writeSettings(patch: SettingsPatch): Settings {
  const cur = readSettings();
  const next: Settings = {
    glass: { view: patch.glass?.view ?? cur.glass.view },
    pet: { enabled: patch.pet?.enabled ?? cur.pet.enabled },
  };
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

/** Whether a settings document has been written yet (defaults otherwise). */
export function settingsStored(): boolean {
  return fs.existsSync(settingsPath());
}
