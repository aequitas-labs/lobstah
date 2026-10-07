import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeModel, workerProfile, WORKER_MODELS, WORKER_MODEL_RE } from '../src/worker-profile.js';
import { observeSessionWorker, sessionWorker } from '../src/session-workers.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-worker-profile-')); process.env.LOBSTAH_HOME = home; });
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

describe('worker metadata privacy boundary', () => {
  it('allows only catalog identifiers and enums; unknown is not guessed', () => {
    for (const id of WORKER_MODELS) { expect(id.length).toBeLessThanOrEqual(64); expect(id).toMatch(WORKER_MODEL_RE); expect(safeModel(id)).toBe(id); }
    for (const id of ['gpt-company-secret', 'claude-private', 'openai/gpt-5', 'my model', 'sonnet\n', 'x'.repeat(65), 'https://private/api', {}, 42]) expect(safeModel(id)).toBe('other');
    expect(safeModel(undefined)).toBeNull();
    expect(safeModel(null)).toBeNull();
    expect(workerProfile({ harness: 'private', model: 'private', effort: 'secret-setting', permissionMode: '/private' })).toEqual({ harness: 'other', model: 'other', config: { effort: null, permissionMode: null } });
  });

  it.each(['claude', 'codex'])('records %s hook observations only, never effort/env/transcripts', (harness) => {
    const session = 'session-1';
    observeSessionWorker({ session_id: session, hook_event_name: 'SessionStart', model: harness === 'claude' ? 'opus' : 'gpt-6.1-sol', permission_mode: 'default', effort: 'high', transcript_path: '/private', prompt: 'secret' } as never, harness);
    expect(sessionWorker(session, harness)).toEqual(workerProfile({ harness, model: harness === 'claude' ? 'opus' : 'gpt-6.1-sol', permissionMode: 'default' }));
    const raw = fs.readFileSync(path.join(home, 'session-workers', `${session}.json`), 'utf8');
    expect(raw).not.toMatch(/secret|private|high|transcript|prompt/);
    // Claude later hook events may omit model; Codex can provide a new one.
    observeSessionWorker({ session_id: session, hook_event_name: 'PostToolUse', permission_mode: 'plan' }, harness);
    expect(sessionWorker(session, harness).model).not.toBeNull();
    observeSessionWorker({ session_id: session, hook_event_name: 'SubagentStop', model: 'other' }, harness);
    expect(sessionWorker(session, harness).model).not.toBe('other');
    // A resumed SessionStart with no observation must not invent old settings.
    observeSessionWorker({ session_id: session, hook_event_name: 'SessionStart' }, harness);
    expect(sessionWorker(session, harness)).toEqual(workerProfile({ harness }));
    observeSessionWorker({ session_id: '../escape', model: 'opus' }, harness);
    expect(fs.existsSync(path.join(home, 'escape.json'))).toBe(false);
  });
});
