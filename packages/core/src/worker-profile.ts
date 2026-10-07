/** Pure, shared telemetry vocabulary. Never accept a provider prefix as proof:
 * custom identifiers (even gpt-* or claude-*) collapse to `other`. */
export const WORKER_HARNESSES = ['claude', 'codex', 'other'] as const;
export const WORKER_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const WORKER_PERMISSIONS = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'] as const;
export const WORKER_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const WORKER_MODELS = [
  'other', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan',
  'claude-opus-4', 'claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-6',
  'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-4', 'claude-sonnet-4-5',
  'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-haiku-4-5',
  'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001', 'claude-opus-4-1-20250805', 'claude-opus-4-5-20251101',
  'gpt-5', 'gpt-5-codex', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.3-codex',
  'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-6', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol',
  'codex-mini-latest', 'o1', 'o3', 'o3-mini', 'o4-mini',
] as const;

export interface WorkerProfile {
  harness: typeof WORKER_HARNESSES[number] | null;
  model: string | null;
  config: {
    effort: typeof WORKER_EFFORTS[number] | null;
    permissionMode: typeof WORKER_PERMISSIONS[number] | null;
  };
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T | null {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : null;
}

export function safeModel(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && WORKER_MODEL_RE.test(value) && (WORKER_MODELS as readonly string[]).includes(value) ? value : 'other';
}

/** Construct fresh objects: extra keys can never hitch a ride. */
export function workerProfile(input: { harness?: unknown; model?: unknown; effort?: unknown; permissionMode?: unknown } = {}): WorkerProfile {
  return {
    harness: input.harness === undefined || input.harness === null ? null : choice(input.harness, WORKER_HARNESSES) ?? 'other',
    model: safeModel(input.model),
    config: { effort: choice(input.effort, WORKER_EFFORTS), permissionMode: choice(input.permissionMode, WORKER_PERMISSIONS) },
  };
}

/** Revalidate even local records before crossing the serialization boundary. */
export function sanitizeWorker(value: Partial<WorkerProfile> | undefined): WorkerProfile {
  return workerProfile({ harness: value?.harness, model: value?.model, effort: value?.config?.effort, permissionMode: value?.config?.permissionMode });
}
