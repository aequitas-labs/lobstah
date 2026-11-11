import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { withDirLock } from './dir-lock.js';
import { reviewSettings, type ReviewsConfig } from './reviews.js';

interface ReviewActivation { active: boolean; since: string }
interface ReviewAutomationState {
  enabled: ReviewActivation;
  repos: Record<string, ReviewActivation>;
}

/**
 * Remember enable and automatic-mode transitions across polls and restarts.
 * Setup calls this when settings change; hand-edited config is observed on the next poll.
 * An explicit requestedAfter timestamp overrides the activation cutoff.
 */
export function reviewAutomationCutoff(config: ReviewsConfig, repoKey?: string, now = Date.now()): string {
  const file = path.join(lobstahHome(), 'review-automation.json');
  if (!config.enabled && !fs.existsSync(file)) return new Date(now).toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withDirLock(`${file}.lock`, () => {
    let state: ReviewAutomationState;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewAutomationState; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = { enabled: { active: false, since: new Date(now).toISOString() }, repos: {} };
    }
    const before = JSON.stringify(state);
    const at = new Date(now).toISOString();
    if (config.enabled && !state.enabled.active) state.enabled.since = at;
    state.enabled.active = config.enabled;
    const keys = new Set(['*', ...Object.keys(config.perRepo), ...Object.keys(state.repos), ...(repoKey ? [repoKey] : [])]);
    for (const key of keys) {
      const automatic = config.enabled && reviewSettings(config, key === '*' ? undefined : key).mode.startsWith('auto-');
      const prior = state.repos[key];
      let since = prior?.since ?? at;
      if (automatic && !prior?.active) {
        const inheritsAutomaticMode = key !== '*' && !config.perRepo[key]?.mode;
        since = !prior && inheritsAutomaticMode ? state.repos['*']!.since : at;
      }
      state.repos[key] = { active: automatic, since };
    }
    if (JSON.stringify(state) !== before || !fs.existsSync(file)) {
      const temporary = uniqueTempPath(file);
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
      atomicRenameSync(temporary, file);
    }
    const settings = reviewSettings(config, repoKey);
    if (settings.requestedAfter !== 'enabled') return settings.requestedAfter;
    const activation = state.repos[repoKey ?? '*']!;
    return state.enabled.since > activation.since ? state.enabled.since : activation.since;
  }, { staleMs: 5000, waitMs: 5000, busy: () => new Error('review automation settings are busy; try again') });
}
