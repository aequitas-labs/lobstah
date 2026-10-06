import type { D1Database, Env, ExecutionContext, ScheduledController } from './bindings.js';

/**
 * lobstah telemetry Worker (PRIVACY.md). Receives one anonymous daily
 * aggregate per install, serves the project-wide catches badge, and a
 * token-protected read of daily totals.
 *
 * - Strict schema: exactly the eight fields, each validated; unknown fields
 *   are rejected.
 * - Idempotent: one row per install id + UTC date, upserted; a retry never
 *   adds to the totals twice.
 * - Stores no IP address, user agent, or other request metadata, and logs
 *   nothing (observability and logpush are off in wrangler.jsonc).
 * - Retention: per-install rows are deleted RETENTION_DAYS after their date
 *   by the daily cron; daily_totals (no install ids) are kept.
 */

export const RETENTION_DAYS = 90;
export const MAX_BODY_BYTES = 1024;
export const FIELDS = ['schema', 'version', 'os', 'arch', 'installId', 'date', 'catchesToday', 'totalCatches'] as const;
const OS = ['macos', 'linux', 'windows', 'other'];
const ARCH = ['x64', 'arm64', 'other'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,32})?$/;
const MAX_CATCHES_TODAY = 10_000;
const MAX_TOTAL_CATCHES = 10_000_000;

export interface Submission {
  schema: 1;
  version: string;
  os: string;
  arch: string;
  installId: string;
  date: string;
  catchesToday: number;
  totalCatches: number;
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function count(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

/** The submission, or why it is refused. The date must be today (UTC) give or take a day of clock skew. */
export function validate(body: unknown, now: number): { ok: true; value: Submission } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) return { ok: false, error: `unknown field: ${unknown[0]!.slice(0, 40)}` };
  const missing = FIELDS.filter((k) => !(k in b));
  if (missing.length > 0) return { ok: false, error: `missing field: ${missing[0]}` };
  if (b.schema !== 1) return { ok: false, error: 'schema must be 1' };
  if (typeof b.version !== 'string' || !VERSION.test(b.version)) return { ok: false, error: 'invalid version' };
  if (typeof b.os !== 'string' || !OS.includes(b.os)) return { ok: false, error: 'invalid os' };
  if (typeof b.arch !== 'string' || !ARCH.includes(b.arch)) return { ok: false, error: 'invalid arch' };
  if (typeof b.installId !== 'string' || !UUID_V4.test(b.installId)) return { ok: false, error: 'invalid installId' };
  const day = 86_400_000;
  if (typeof b.date !== 'string' || ![utcDate(now - day), utcDate(now), utcDate(now + day)].includes(b.date)) {
    return { ok: false, error: 'date must be the current UTC date' };
  }
  if (!count(b.catchesToday, MAX_CATCHES_TODAY)) return { ok: false, error: 'invalid catchesToday' };
  if (!count(b.totalCatches, MAX_TOTAL_CATCHES)) return { ok: false, error: 'invalid totalCatches' };
  if (b.catchesToday > b.totalCatches) return { ok: false, error: 'catchesToday exceeds totalCatches' };
  return { ok: true, value: b as unknown as Submission };
}

/**
 * Daily totals first (they read the install's rows before this submission),
 * then the install's row, in one transaction. A repeat of the same
 * submission adds nothing: it is neither a new install for the date nor
 * growth in its counts.
 */
export async function record(db: D1Database, s: Submission): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO daily_totals (date, active_installs, catches_today, new_catches)
         SELECT ?2,
                CASE WHEN prev.today IS NULL THEN 1 ELSE 0 END,
                MAX(0, ?3 - COALESCE(prev.today, 0)),
                MAX(0, ?4 - COALESCE(prev.best, 0))
         FROM (SELECT (SELECT catches_today FROM submissions WHERE install_id = ?1 AND date = ?2) AS today,
                      (SELECT MAX(total_catches) FROM submissions WHERE install_id = ?1) AS best) AS prev
         WHERE true
         ON CONFLICT(date) DO UPDATE SET
           active_installs = active_installs + excluded.active_installs,
           catches_today = catches_today + excluded.catches_today,
           new_catches = new_catches + excluded.new_catches`,
      )
      .bind(s.installId, s.date, s.catchesToday, s.totalCatches),
    db
      .prepare(
        `INSERT INTO submissions (install_id, date, version, os, arch, catches_today, total_catches)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(install_id, date) DO UPDATE SET
           version = excluded.version, os = excluded.os, arch = excluded.arch,
           catches_today = MAX(catches_today, excluded.catches_today),
           total_catches = MAX(total_catches, excluded.total_catches)`,
      )
      .bind(s.installId, s.date, s.version, s.os, s.arch, s.catchesToday, s.totalCatches),
  ]);
}

/** Delete per-install rows older than the retention period. Daily totals stay. */
export async function prune(db: D1Database, now: number): Promise<void> {
  await db.prepare('DELETE FROM submissions WHERE date < ?1').bind(utcDate(now - RETENTION_DAYS * 86_400_000)).run();
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function submit(request: Request, env: Env, now: number): Promise<Response> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'content-type must be application/json' }, 415);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'body is not JSON' }, 400);
  }
  const v = validate(body, now);
  if (!v.ok) return json({ error: v.error }, 400);
  if (env.GLOBAL_LIMITER && !(await env.GLOBAL_LIMITER.limit({ key: 'submit' })).success) return json({ error: 'rate limited' }, 429);
  if (env.SUBMIT_LIMITER && !(await env.SUBMIT_LIMITER.limit({ key: v.value.installId })).success) return json({ error: 'rate limited' }, 429);
  await record(env.DB, v.value);
  return new Response(null, { status: 204 });
}

/** shields.io endpoint JSON: `🦞 N`, N the catches across every sharing install. */
async function badge(env: Env): Promise<Response> {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(new_catches), 0) AS n FROM daily_totals').first<{ n: number }>();
  return json(
    { schemaVersion: 1, label: '🦞', message: String(row?.n ?? 0), color: 'e05d44', cacheSeconds: 3600 },
    200,
    { 'cache-control': 'public, max-age=300' },
  );
}

/** Compare via SHA-256 digests: equal-length inputs, no early exit. */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Totals and active installs per day, for the maintainers. Bearer READ_TOKEN. */
async function stats(request: Request, env: Env, url: URL, now: number): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!env.READ_TOKEN || !token || !(await tokenMatches(token, env.READ_TOKEN))) {
    return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }
  const days = Math.min(Math.max(Number.parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), 3660);
  const since = utcDate(now - (days - 1) * 86_400_000);
  const [total, rows] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(SUM(new_catches), 0) AS n FROM daily_totals').first<{ n: number }>(),
    env.DB.prepare(
      'SELECT date, active_installs AS activeInstalls, catches_today AS catchesToday, new_catches AS newCatches FROM daily_totals WHERE date >= ?1 ORDER BY date',
    )
      .bind(since)
      .all(),
  ]);
  return json({ totalCatches: total?.n ?? 0, retentionDays: RETENTION_DAYS, days: rows.results });
}

export async function handle(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/v1/daily') return request.method === 'POST' ? await submit(request, env, now) : json({ error: 'method not allowed' }, 405, { allow: 'POST' });
    if (url.pathname === '/badge/catches.json') return request.method === 'GET' ? await badge(env) : json({ error: 'method not allowed' }, 405, { allow: 'GET' });
    if (url.pathname === '/v1/stats') return request.method === 'GET' ? await stats(request, env, url, now) : json({ error: 'method not allowed' }, 405, { allow: 'GET' });
    return json({ error: 'not found' }, 404);
  } catch {
    // No detail and no log: an error message could echo request data.
    return json({ error: 'internal error' }, 500);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(prune(env.DB, controller.scheduledTime));
  },
};
