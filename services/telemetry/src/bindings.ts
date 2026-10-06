// The slices of the Workers runtime this Worker uses, declared here so the
// folder needs no @cloudflare/workers-types install. `wrangler types` can
// replace these when the Worker is deployed.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** Runs the statements as one transaction. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

/** A Workers Rate Limiting binding. */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  /** Per install id: a retry loop cannot hammer the database. */
  SUBMIT_LIMITER?: RateLimit;
  /** One key for every submission: a flood of made-up install ids is capped too. */
  GLOBAL_LIMITER?: RateLimit;
  /** Bearer token for GET /v1/stats. Unset: the route refuses every request. */
  READ_TOKEN?: string;
}

export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
