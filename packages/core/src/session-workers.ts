import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueTempPath, atomicRenameSync, lobstahHome } from './paths.js';
import { workerMetadata } from './worker-metadata.js';
import type { WorkerMetadata } from './worker-metadata.js';
import { updateTrapWorker } from './soak.js';
import { updateHelmWorker } from './helm.js';

function file(session: string): string | undefined {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(session) ? path.join(lobstahHome(), 'session-workers', `${session}.json`) : undefined;
}
/** SessionStart can precede sign-on. Cache only the observed fields so a later
 * registration can seed itself without reading transcripts or agent settings. */
export function sessionWorker(session: string, harness?: string): WorkerMetadata {
  try {
    const p = file(session);
    const saved = p ? JSON.parse(fs.readFileSync(p, 'utf8')) as WorkerMetadata : undefined;
    return workerMetadata({ ...saved, harness: harness ?? saved?.harness });
  } catch {
    return workerMetadata({ harness });
  }
}
export function observeSessionWorker(input: { session_id?: string; model?: unknown; permission_mode?: unknown; hook_event_name?: string }, harness?: string): void {
  try {
    if (!input.session_id || input.hook_event_name?.startsWith('Subagent')) return;
    const p = file(input.session_id);
    if (!p) return;
    const old = sessionWorker(input.session_id, harness);
    const starting = input.hook_event_name === 'SessionStart';
    const next = workerMetadata({ harness: harness ?? old.harness,
      model: input.model === undefined && !starting ? old.model : input.model,
      config: { effort: null, permissionMode: input.permission_mode === undefined && !starting ? old.config.permissionMode : input.permission_mode },
      observedAt: starting || input.model !== undefined || input.permission_mode !== undefined ? new Date().toISOString() : old.observedAt,
    });
    const text = JSON.stringify(next);
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = uniqueTempPath(p);
      fs.writeFileSync(tmp, text);
      atomicRenameSync(tmp, p);
    }
    updateTrapWorker(input.session_id, next);
    updateHelmWorker(input.session_id, next);
  } catch {
    // Observational metadata must not break the hook.
  }
}
