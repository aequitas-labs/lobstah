import { describe, expect, it } from 'vitest';
import { safeModel, sanitizeWorker, workerProfile, WORKER_MODELS, WORKER_MODEL_RE } from '../src/worker-profile.js';
import { workerMetadata } from '../src/worker-metadata.js';

describe('worker metadata privacy boundary', () => {
  it('allows only catalog identifiers and enums; unknown is not guessed', () => {
    for (const id of WORKER_MODELS) { expect(id.length).toBeLessThanOrEqual(64); expect(id).toMatch(WORKER_MODEL_RE); expect(safeModel(id)).toBe(id); }
    for (const id of ['gpt-company-secret', 'claude-private', 'openai/gpt-5', 'my model', 'sonnet\n', 'x'.repeat(65), 'https://private/api', {}, 42]) expect(safeModel(id)).toBe('other');
    expect(safeModel(undefined)).toBeNull();
    expect(safeModel(null)).toBeNull();
    expect(workerProfile({ harness: 'private', model: 'private', effort: 'secret-setting', permissionMode: '/private' })).toEqual({ harness: 'other', model: 'other', config: { effort: null, permissionMode: null } });
  });

  it('scrubs recorded local metadata without redetecting session settings', () => {
    const local = workerMetadata({ harness: 'codex', model: 'my-provider/custom-model', config: { effort: 'high', permissionMode: 'plan' } });
    expect(local.model).toBe('my-provider/custom-model');
    expect(sanitizeWorker(local)).toEqual({ harness: 'codex', model: 'other', config: { effort: 'high', permissionMode: 'plan' } });
    expect(sanitizeWorker(workerMetadata({ harness: 'claude', model: 'sonnet' }))).toEqual(workerProfile({ harness: 'claude', model: 'sonnet' }));
  });
});
