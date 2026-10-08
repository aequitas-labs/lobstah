import type { D1Database, Env, ExecutionContext, ScheduledController } from './bindings.js';
import { WORKER_HARNESSES, WORKER_MODELS, WORKER_MODEL_RE } from '../../../packages/core/src/worker-profile.js';
import { WORKER_EFFORTS, WORKER_PERMISSIONS } from '../../../packages/core/src/worker-metadata.js';
import type { WorkerProfile } from '../../../packages/core/src/worker-profile.js';

/**
 * lobstah telemetry Worker (PRIVACY.md). Receives one anonymous daily
 * aggregate per install, serves the project-wide catches badge, and a
 * token-protected read of daily totals.
 *
 * - Strict schema: ten fields, including nested catches and worker metadata, each
 *   validated; unknown fields at every level are rejected.
 * - Idempotent: one row per install id + UTC date, upserted; a retry never
 *   adds to the totals twice.
 * - Stores no IP address, user agent, or other request metadata, and logs
 *   nothing (observability and logpush are off in wrangler.jsonc).
 * - Retention: per-install and per-trap rows are deleted RETENTION_DAYS
 *   after their date by the daily cron; daily_totals (no ids or names) stay.
 */

export const RETENTION_DAYS = 90;
export const MAX_BODY_BYTES = 65536;
export const MAX_TRAPS = 100;
export const MAX_WORKERS = 100;
export const FIELDS = ['schema', 'version', 'os', 'arch', 'installId', 'date', 'catches', 'helm', 'traps', 'byWorker'] as const;
const TRAP_NAME = /^[a-z]{2,8}-[a-z]{2,8}$/;
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
  catches: { today: number; total: number };
  helm: WorkerProfile | null;
  traps: Array<WorkerProfile & { name: string; today: number }>;
  byWorker: Array<WorkerProfile & { today: number }>;
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function count(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function enumOrNull(v: unknown, choices: readonly string[]): boolean {
  return v === null || typeof v === 'string' && choices.includes(v);
}

/** Reject instead of coercing arbitrary model/config input on the server. */
function profile(v: Record<string, unknown>): WorkerProfile | undefined {
  if (!enumOrNull(v.harness, WORKER_HARNESSES) ||
      !(v.model === null || typeof v.model === 'string' && WORKER_MODEL_RE.test(v.model) && (WORKER_MODELS as readonly string[]).includes(v.model)) ||
      !object(v.config) || Object.keys(v.config).some((k) => k !== 'effort' && k !== 'permissionMode') ||
      !enumOrNull(v.config.effort, WORKER_EFFORTS) || !enumOrNull(v.config.permissionMode, WORKER_PERMISSIONS)) return undefined;
  return { harness: v.harness, model: v.model, config: { effort: v.config.effort, permissionMode: v.config.permissionMode } } as WorkerProfile;
}

const PROFILE_KEYS = ['harness', 'model', 'config'];

/** The submission, or why it is refused. The date must be today (UTC) give or take a day of clock skew. */
export function validate(body: unknown, now: number): { ok: true; value: Submission } | { ok: false; error: string } {
  if (!object(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body;
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
  if (!object(b.catches) || Object.keys(b.catches).some((k) => k !== 'today' && k !== 'total')) return { ok: false, error: 'invalid catches' };
  const { today, total } = b.catches;
  if (!count(today, MAX_CATCHES_TODAY) || !count(total, MAX_TOTAL_CATCHES) || today > total) return { ok: false, error: 'invalid catches counts' };
  let helm: WorkerProfile | null = null;
  if (b.helm !== null) {
    if (!object(b.helm) || Object.keys(b.helm).some((k) => !PROFILE_KEYS.includes(k))) return { ok: false, error: 'invalid helm' };
    const p = profile(b.helm);
    if (!p) return { ok: false, error: 'invalid helm worker' };
    helm = p;
  }
  if (!Array.isArray(b.traps) || b.traps.length > MAX_TRAPS) return { ok: false, error: 'invalid traps: maximum 100' };
  const traps: Submission['traps'] = [];
  const names = new Set<string>();
  let trapCatches = 0;
  for (const t of b.traps) {
    if (!object(t) || Object.keys(t).some((k) => !['name', 'today', ...PROFILE_KEYS].includes(k)) ||
        typeof t.name !== 'string' || t.name.length < 5 || t.name.length > 17 || t.name.trim() !== t.name || !TRAP_NAME.test(t.name) ||
        !count(t.today, MAX_CATCHES_TODAY) || t.today === 0 || names.has(t.name)) return { ok: false, error: 'invalid trap' };
    names.add(t.name);
    trapCatches += t.today;
    const p = profile(t);
    if (!p) return { ok: false, error: 'invalid trap worker' };
    traps.push({ name: t.name, today: t.today, ...p });
  }
  if (!Array.isArray(b.byWorker) || b.byWorker.length > MAX_WORKERS) return { ok: false, error: 'invalid byWorker: maximum 100' };
  const byWorker: Submission['byWorker'] = [];
  const workers = new Set<string>();
  for (const w of b.byWorker) {
    if (!object(w) || Object.keys(w).some((k) => !['today', ...PROFILE_KEYS].includes(k)) || !count(w.today, MAX_CATCHES_TODAY) || w.today === 0) return { ok: false, error: 'invalid headless worker' };
    const p = profile(w);
    if (!p || workers.has(JSON.stringify(p))) return { ok: false, error: 'invalid/duplicate headless worker' };
    workers.add(JSON.stringify(p));
    trapCatches += w.today;
    byWorker.push({ ...p, today: w.today });
  }
  if (trapCatches > today) return { ok: false, error: 'worker counts exceed catches.today' };
  return { ok: true, value: { schema: 1, version: b.version, os: b.os, arch: b.arch, installId: b.installId, date: b.date, catches: { today, total }, helm, traps, byWorker } };
}

/** Counts only: the indefinite table has neither names, config nor identities.
 * Omitted traps/legacy evidence contribute to the null/null bucket. */
function attribution(s: Submission): Array<{ harness: string; model: string; today: number }> {
  const rows = new Map<string, { harness: string; model: string; today: number }>();
  const add = (harness: string | null, model: string | null, today: number) => {
    const key = JSON.stringify([harness, model]);
    const previous = rows.get(key);
    rows.set(key, { harness: harness ?? '', model: model ?? '', today: (previous?.today ?? 0) + today });
  };
  for (const r of [...s.traps, ...s.byWorker]) add(r.harness, r.model, r.today);
  const missing = s.catches.today - [...rows.values()].reduce((n, r) => n + r.today, 0);
  if (missing > 0) add(null, null, missing);
  return [...rows.values()];
}

/**
 * Daily totals first (they read the install's rows before this submission),
 * then the install's row, in one transaction. A repeat of the same
 * submission adds nothing: it is neither a new install for the date nor
 * growth in its counts.
 */
export async function record(db: D1Database, s: Submission): Promise<void> {
  const attributed = JSON.stringify(attribution(s));
  await db.batch([
    // Replace this install/date's previous contribution, including buckets
    // removed by a correction. One transaction makes retries idempotent.
    db.prepare(`INSERT INTO daily_worker_totals (date, harness, model, catches_today)
      SELECT ?2, harness, model, SUM(n) FROM (
        SELECT json_extract(value, '$.harness') AS harness, json_extract(value, '$.model') AS model,
               json_extract(value, '$.today') AS n FROM json_each(?3)
        UNION ALL SELECT harness, model, -catches_today FROM attribution_submissions WHERE install_id = ?1 AND date = ?2
      ) WHERE true GROUP BY harness, model
      ON CONFLICT(date, harness, model) DO UPDATE SET catches_today = catches_today + excluded.catches_today`)
      .bind(s.installId, s.date, attributed),
    db.prepare('DELETE FROM attribution_submissions WHERE install_id = ?1 AND date = ?2').bind(s.installId, s.date),
    db.prepare(`INSERT INTO attribution_submissions (install_id, date, harness, model, catches_today)
      SELECT ?1, ?2, json_extract(value, '$.harness'), json_extract(value, '$.model'), json_extract(value, '$.today') FROM json_each(?3)`)
      .bind(s.installId, s.date, attributed),
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
      .bind(s.installId, s.date, s.catches.today, s.catches.total),
    db
      .prepare(
        `INSERT INTO submissions (install_id, date, version, os, arch, catches_today, total_catches, helm)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(install_id, date) DO UPDATE SET
           version = excluded.version, os = excluded.os, arch = excluded.arch, helm = excluded.helm,
           catches_today = MAX(catches_today, excluded.catches_today),
           total_catches = MAX(total_catches, excluded.total_catches)`,
      )
      .bind(s.installId, s.date, s.version, s.os, s.arch, s.catches.today, s.catches.total, s.helm === null ? null : JSON.stringify(s.helm)),
    // Replace the bounded snapshot, not a union that can grow beyond 100.
    db.prepare('DELETE FROM trap_submissions WHERE install_id = ?1 AND date = ?2').bind(s.installId, s.date),
    db.prepare(`INSERT INTO trap_submissions (install_id, date, name, catches_today, harness, model, effort, permission_mode)
                SELECT ?1, ?2, json_extract(value, '$.name'), json_extract(value, '$.today'), json_extract(value, '$.harness'),
                       json_extract(value, '$.model'), json_extract(value, '$.config.effort'), json_extract(value, '$.config.permissionMode') FROM json_each(?3)`)
      .bind(s.installId, s.date, JSON.stringify(s.traps)),
    db.prepare('DELETE FROM worker_submissions WHERE install_id = ?1 AND date = ?2').bind(s.installId, s.date),
    db.prepare(`INSERT INTO worker_submissions (install_id, date, harness, model, effort, permission_mode, catches_today)
      SELECT ?1, ?2, COALESCE(json_extract(value, '$.harness'), ''), COALESCE(json_extract(value, '$.model'), ''),
             COALESCE(json_extract(value, '$.config.effort'), ''), COALESCE(json_extract(value, '$.config.permissionMode'), ''),
             json_extract(value, '$.today') FROM json_each(?3)`)
      .bind(s.installId, s.date, JSON.stringify(s.byWorker)),
  ]);
}

/** Delete per-install/trap rows older than the retention period. Nameless daily totals stay. */
export async function prune(db: D1Database, now: number): Promise<void> {
  const cutoff = utcDate(now - RETENTION_DAYS * 86_400_000);
  await db.batch([
    db.prepare('DELETE FROM trap_submissions WHERE date < ?1').bind(cutoff),
    db.prepare('DELETE FROM worker_submissions WHERE date < ?1').bind(cutoff),
    db.prepare('DELETE FROM attribution_submissions WHERE date < ?1').bind(cutoff),
    db.prepare('DELETE FROM submissions WHERE date < ?1').bind(cutoff),
  ]);
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
  // Do not buffer an unbounded request when Content-Length is absent or false.
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return json({ error: 'body too large' }, 413);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
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
  const [total, rows, workers] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(SUM(new_catches), 0) AS n FROM daily_totals').first<{ n: number }>(),
    env.DB.prepare(
      'SELECT date, active_installs AS activeInstalls, catches_today AS catchesToday, new_catches AS newCatches FROM daily_totals WHERE date >= ?1 ORDER BY date',
    )
      .bind(since)
      .all(),
    env.DB.prepare(`SELECT date, NULLIF(harness, '') AS harness, NULLIF(model, '') AS model, catches_today AS catchesToday
                    FROM daily_worker_totals WHERE date >= ?1 AND catches_today > 0 ORDER BY date, harness, model`).bind(since).all(),
  ]);
  return json({ totalCatches: total?.n ?? 0, retentionDays: RETENTION_DAYS, days: rows.results, byWorker: workers.results });
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
