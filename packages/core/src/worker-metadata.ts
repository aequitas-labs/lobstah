/** Local observations, not a telemetry vocabulary. Custom model IDs remain
 * visible locally; the wire layer must apply its own catalog allowlist. */
export const WORKER_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const WORKER_PERMISSIONS = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'] as const;
export interface WorkerConfig {
  effort: typeof WORKER_EFFORTS[number] | null;
  permissionMode: typeof WORKER_PERMISSIONS[number] | null;
}
export interface WorkerMetadata {
  harness: string | null;
  model: string | null;
  config: WorkerConfig;
  /** Local hook/launch observation time; absent on older records. */
  observedAt?: string;
}
export function localModel(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value) ? value : null;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === 'string' && values.includes(value as T) ? value as T : null;
}
export function workerMetadata(input: { harness?: unknown; model?: unknown; config?: { effort?: unknown; permissionMode?: unknown }; observedAt?: unknown } = {}): WorkerMetadata {
  return {
    harness: localModel(input.harness),
    model: localModel(input.model),
    config: { effort: choice(input.config?.effort, WORKER_EFFORTS), permissionMode: choice(input.config?.permissionMode, WORKER_PERMISSIONS) },
    ...(typeof input.observedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.observedAt) && Number.isFinite(Date.parse(input.observedAt)) ? { observedAt: input.observedAt } : {}),
  };
}
export function workerLabel(input: { harness?: unknown; model?: unknown; config?: Partial<WorkerConfig> }): string {
  const w = workerMetadata(input);
  return [w.harness ?? 'unknown harness', w.model ?? 'unknown model', w.config.effort, w.config.permissionMode].filter(Boolean).join(' · ');
}
