/** The Stop-hook entry `lobstah man init` installs. */
export const HAUL_HOOK = { type: 'command', command: 'lobstah man haul', timeout: 14400 } as const;

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}
interface StopMatcher {
  matcher?: string;
  hooks?: HookEntry[];
}
interface Settings {
  hooks?: { Stop?: StopMatcher[]; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Merge the haul hook into a Claude Code settings object. Idempotent, and
 * never touches anything but hooks.Stop — existing hooks and settings are
 * preserved verbatim.
 */
export function mergeHaulHook(existing: unknown): { settings: Settings; changed: boolean } {
  const settings: Settings =
    existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Settings) : {};
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const stop: StopMatcher[] = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  const present = stop.some((m) => (m.hooks ?? []).some((h) => h.command?.includes('lobstah man haul')));
  if (present) return { settings, changed: false };
  stop.push({ hooks: [{ ...HAUL_HOOK }] });
  settings.hooks.Stop = stop;
  return { settings, changed: true };
}
