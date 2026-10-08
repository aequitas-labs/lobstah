import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import type { D1Database, D1PreparedStatement, D1Result, Env, RateLimit } from '../src/bindings.js';
import worker, { FIELDS, MAX_BODY_BYTES, MAX_TRAPS, RETENTION_DAYS, handle, utcDate, validate } from '../src/index.js';

// The client's allowed keys and the Worker's must be the same list.
import { TELEMETRY_FIELDS, TELEMETRY_MAX_TRAPS, TELEMETRY_MAX_WORKERS } from '../../../packages/core/src/telemetry.js';
import { workerProfile } from '../../../packages/core/src/worker-profile.js';
import { TRAP_FIRST_WORDS, TRAP_LAST_WORDS } from '../../../packages/core/src/trap-names.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const TODAY = utcDate(NOW);
const ID = '3b0c8f9e-6a1d-4c2e-9f3a-1b2c3d4e5f60';
const OTHER = '7e1d2c3b-4a5f-4e6d-8c7b-0a9f8e7d6c5b';

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 1, version: '0.6.9', os: 'macos', arch: 'arm64', installId: ID, date: TODAY, catches: { today: 3, total: 40 }, helm: null, traps: [{ name: 'kind-crab', today: 2, ...workerProfile() }], byWorker: [], ...over };
}

describe('telemetry Worker validation', () => {
  it('accepts known profiles or explicit nulls, rejects all free text and extra nested keys', () => {
    const safe = workerProfile({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'default' });
    expect(validate(payload({ helm: safe, traps: [{ name: 'kind-crab', today: 2, ...safe }], byWorker: [{ ...workerProfile(), today: 1 }] }), NOW).ok).toBe(true);
    for (const bad of [
      { ...safe, harness: 'company harness' }, { ...safe, model: 'gpt-private' },
      { ...safe, model: 'opus\n' }, { ...safe, model: 'x'.repeat(65) }, { ...safe, model: 'openai/gpt-5' },
      { ...safe, config: { ...safe.config, effort: 'custom' } },
      { ...safe, config: { ...safe.config, permissionMode: 'custom' } },
      { ...safe, config: { effort: 'high' } }, { ...safe, config: { ...safe.config, apiHost: 'private' } },
      { ...safe, prompt: 'private' }, { ...safe, config: null }, { model: 'opus' },
    ]) {
      expect(validate(payload({ helm: bad }), NOW).ok).toBe(false);
      expect(validate(payload({ traps: [{ ...bad, name: 'kind-crab', today: 1 }] }), NOW).ok).toBe(false);
      expect(validate(payload({ byWorker: [{ ...bad, today: 1 }] }), NOW).ok).toBe(false);
    }
    expect(validate(payload({ byWorker: [{ ...safe, today: 2 }] }), NOW).ok).toBe(false); // trap + headless > today
    expect(validate(payload({ traps: [], byWorker: [{ ...safe, today: 1 }, { ...safe, today: 1 }] }), NOW).ok).toBe(false);
    expect(validate(payload({ traps: [], byWorker: Array.from({ length: 101 }, () => ({ ...safe, today: 1 })) }), NOW).ok).toBe(false);
  });

  it('accepts exactly the client payload fields', () => {
    expect([...FIELDS]).toEqual([...TELEMETRY_FIELDS]);
    expect(MAX_TRAPS).toBe(TELEMETRY_MAX_TRAPS);
    expect(TELEMETRY_MAX_WORKERS).toBe(100);
    expect(validate(payload(), NOW)).toMatchObject({ ok: true });
  });

  it.each([
    ['an unknown field', { repo: 'acme/app' }],
    ['a hostname', { hostname: 'box' }],
    ['schema 2', { schema: 2 }],
    ['a free-form version', { version: 'my laptop' }],
    ['an unknown os', { os: 'darwin 24.6' }],
    ['an unknown arch', { arch: 'ia32' }],
    ['an install id that is not a v4 UUID', { installId: 'chris-macbook' }],
    ['an upper-case install id', { installId: ID.toUpperCase() }],
    ['a date in the past', { date: utcDate(NOW - 3 * DAY) }],
    ['a malformed date', { date: '2026-10-6' }],
    ['old flat counts', { catchesToday: 3, totalCatches: 40 }],
    ['a fractional count', { catches: { today: 1.5, total: 40 } }],
    ['a negative count', { catches: { today: 3, total: -1 } }],
    ['a string count', { catches: { today: 3, total: '40' } }],
    ['a huge count', { catches: { today: 3, total: 1e12 } }],
    ['today above the total', { catches: { today: 41, total: 40 } }],
    ['a missing nested count', { catches: { total: 40 } }],
    ['an extra nested key', { catches: { today: 3, total: 40, repo: 'secret' } }],
    ['a missing trap count', { traps: [{ name: 'kind-crab' }] }],
    ['an extra trap key', { traps: [{ name: 'kind-crab', today: 1, repo: 'secret' }] }],
    ['a zero trap count', { traps: [{ name: 'kind-crab', today: 0 }] }],
    ['a fractional trap count', { traps: [{ name: 'kind-crab', today: 0.5 }] }],
    ['a negative trap count', { traps: [{ name: 'kind-crab', today: -1 }] }],
    ['a string trap count', { traps: [{ name: 'kind-crab', today: '1' }] }],
    ['a short name', { traps: [{ name: 'x-crab', today: 1 }] }],
    ['a long name', { traps: [{ name: 'toolonggg-crab', today: 1 }] }],
    ['an uppercase name', { traps: [{ name: 'Kind-crab', today: 1 }] }],
    ['a newline name', { traps: [{ name: 'kind-crab\n', today: 1 }] }],
    ['a name with punctuation', { traps: [{ name: 'kind.crab', today: 1 }] }],
    ['duplicate names', { traps: [{ name: 'kind-crab', today: 1 }, { name: 'kind-crab', today: 1 }] }],
    ['trap counts above the total today', { traps: [{ name: 'kind-crab', today: 4 }] }],
    ['a non-array table', { traps: { name: 'kind-crab', today: 1 } }],
  ])('rejects %s', (_name, over) => {
    expect(validate(payload(over), NOW)).toMatchObject({ ok: false });
  });

  it('accepts 100 names within the body bound, rejects 101, and accepts headless-only totals', () => {
    const traps = Array.from({ length: 101 }, (_, i) => ({ name: `${TRAP_FIRST_WORDS[Math.floor(i / 64)]}-${TRAP_LAST_WORDS[i % 64]}`, today: 1, ...workerProfile() }));
    const accepted = payload({ catches: { today: 100, total: 100 }, traps: traps.slice(0, 100) });
    expect(validate(accepted, NOW).ok).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(accepted)).length).toBeLessThan(MAX_BODY_BYTES);
    expect(validate(payload({ catches: { today: 101, total: 101 }, traps }), NOW).ok).toBe(false);
    expect(validate(payload({ traps: [] }), NOW).ok).toBe(true);
  });

  it('rejects a missing field and a non-object', () => {
    const { arch: _arch, ...rest } = payload();
    expect(validate(rest, NOW)).toEqual({ ok: false, error: 'missing field: arch' });
    expect(validate([payload()], NOW)).toMatchObject({ ok: false });
    expect(validate(null, NOW)).toMatchObject({ ok: false });
  });

  it('keeps logs off and binds no IP-keyed limiter', () => {
    const config = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(config).toMatch(/"observability":\s*\{\s*"enabled": false/);
    expect(config).toContain('"logpush": false');
    expect(config).toContain('"invocation_logs": false');
    const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/CF-Connecting-IP|x-forwarded-for|request\.cf|console\./i);
  });
});

// D1 is SQLite: node:sqlite (Node 22.5+) stands in for it. On older Node the
// database tests skip; validation above runs everywhere.
type Sqlite = { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number | bigint } } };
let DatabaseSync: (new (path: string) => Sqlite) | undefined;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => Sqlite });
} catch {
  DatabaseSync = undefined;
}

function fakeD1(): D1Database {
  const db = new DatabaseSync!(':memory:');
  db.exec(fs.readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const statement = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async <T>() => ((db.prepare(sql).all(...params)[0] as T | undefined) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[], success: true, meta: {} }),
    run: async () => ({ results: [], success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out: D1Result[] = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

function limiter(limit: number): RateLimit {
  const seen = new Map<string, number>();
  return {
    limit: async ({ key }) => {
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return { success: seen.get(key)! <= limit };
    },
  };
}

function env(over: Partial<Env> = {}): Env {
  return { DB: fakeD1(), READ_TOKEN: 'read-secret', ...over };
}

const post = (e: Env, body: unknown, now = NOW, headers: Record<string, string> = {}) =>
  handle(
    new Request('https://t.example/v1/daily', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    e,
    now,
  );
const get = (e: Env, path: string, headers: Record<string, string> = {}, now = NOW) => handle(new Request(`https://t.example${path}`, { headers }), e, now);
const badge = async (e: Env) => (await (await get(e, '/badge/catches.json')).json()) as { schemaVersion: number; label: string; message: string };
const stats = async (e: Env, days = 30, now = NOW) =>
  (await (await get(e, `/v1/stats?days=${days}`, { authorization: 'Bearer read-secret' }, now)).json()) as {
    totalCatches: number;
    days: Array<{ date: string; activeInstalls: number; catchesToday: number; newCatches: number }>;
  };

describe.skipIf(!DatabaseSync)('telemetry Worker storage', () => {
  it('stores config for 90 days, retains only anonymous harness/model counts, and corrects retries atomically', async () => {
    const e = env();
    const trap = workerProfile({ harness: 'codex', model: 'gpt-5', effort: 'high', permissionMode: 'default' });
    const headless = workerProfile({ harness: 'claude', model: 'sonnet', effort: 'max', permissionMode: 'bypassPermissions' });
    const s = payload({ helm: trap, traps: [{ name: 'kind-crab', today: 2, ...trap }], byWorker: [{ ...headless, today: 1 }] });
    expect((await post(e, s)).status).toBe(204);
    expect((await post(e, s)).status).toBe(204);
    expect((await e.DB.prepare('SELECT harness, model, catches_today FROM daily_worker_totals ORDER BY harness').all()).results).toEqual([
      { harness: 'claude', model: 'sonnet', catches_today: 1 }, { harness: 'codex', model: 'gpt-5', catches_today: 2 },
    ]);
    expect((await e.DB.prepare('SELECT effort, permission_mode FROM worker_submissions').all()).results).toEqual([{ effort: 'max', permission_mode: 'bypassPermissions' }]);
    // A corrected model snapshot subtracts the old bucket: no second catch.
    const revised = payload({ helm: null, traps: [{ name: 'kind-crab', today: 2, ...trap }], byWorker: [{ ...headless, model: 'opus', today: 1 }] });
    await post(e, revised);
    await post(e, revised);
    const totals = (await e.DB.prepare('SELECT model, catches_today FROM daily_worker_totals WHERE catches_today > 0 ORDER BY model').all()).results;
    expect(totals).toEqual([{ model: 'gpt-5', catches_today: 2 }, { model: 'opus', catches_today: 1 }]);
    const columns = (await e.DB.prepare("SELECT name FROM pragma_table_info('daily_worker_totals')").all<{ name: string }>()).results.map((r) => r.name);
    expect(columns).toEqual(['date', 'harness', 'model', 'catches_today']);
    const waits: Promise<unknown>[] = [];
    worker.scheduled({ scheduledTime: NOW + (RETENTION_DAYS + 1) * DAY, cron: '17 3 * * *' }, e, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    for (const table of ['submissions', 'trap_submissions', 'worker_submissions', 'attribution_submissions']) {
      expect((await e.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n).toBe(0);
    }
    expect((await e.DB.prepare('SELECT SUM(catches_today) AS n FROM daily_worker_totals').first<{ n: number }>())?.n).toBe(3);
    expect((await badge(e)).message).toBe('40');
  });

  it('attributes omitted traps to unknown without deriving totals from the bounded list', async () => {
    const e = env();
    const w = workerProfile({ harness: 'claude', model: 'sonnet' });
    await post(e, payload({ traps: [], byWorker: [{ ...w, today: 1 }] }));
    expect((await e.DB.prepare('SELECT harness, model, catches_today FROM daily_worker_totals ORDER BY harness').all()).results).toEqual([
      { harness: '', model: '', catches_today: 2 }, { harness: 'claude', model: 'sonnet', catches_today: 1 },
    ]);
  });

  it('upserts by install and date: a retry never double-counts', async () => {
    const e = env();
    expect((await post(e, payload())).status).toBe(204);
    expect((await post(e, payload())).status).toBe(204);
    expect((await post(e, payload())).status).toBe(204);
    expect(await badge(e)).toEqual({ schemaVersion: 1, label: '🦞', message: '40', color: 'e05d44', cacheSeconds: 3600 });
    expect((await stats(e)).days).toEqual([{ date: TODAY, activeInstalls: 1, catchesToday: 3, newCatches: 40 }]);
  });

  it('counts each install once per day and only growth in its total', async () => {
    const e = env();
    await post(e, payload({ date: utcDate(NOW - DAY), catches: { today: 1, total: 37 }, traps: [] }), NOW - DAY);
    await post(e, payload());
    await post(e, payload({ installId: OTHER, catches: { today: 2, total: 5 } }));
    // A later same-day submission with higher counts adds only the difference.
    await post(e, payload({ installId: OTHER, catches: { today: 4, total: 7 } }));
    // A total that went down (a reset store) adds nothing.
    await post(e, payload({ date: utcDate(NOW + DAY), catches: { today: 0, total: 10 }, traps: [] }), NOW + DAY);
    expect((await badge(e)).message).toBe(String(40 + 7));
    const s = await stats(e, 30, NOW + DAY);
    expect(s.totalCatches).toBe(47);
    expect(s.days).toEqual([
      { date: utcDate(NOW - DAY), activeInstalls: 1, catchesToday: 1, newCatches: 37 },
      { date: TODAY, activeInstalls: 2, catchesToday: 3 + 4, newCatches: 3 + 7 },
      { date: utcDate(NOW + DAY), activeInstalls: 1, catchesToday: 0, newCatches: 0 },
    ]);
  });

  it('rejects bad requests before touching the database', async () => {
    const e = env();
    expect((await post(e, payload({ path: '/Users/me/src/app' }))).status).toBe(400);
    expect((await post(e, 'not json')).status).toBe(400);
    expect((await post(e, payload(), NOW, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(e, JSON.stringify({ ...payload(), pad: 'x'.repeat(MAX_BODY_BYTES) }))).status).toBe(413);
    expect((await get(e, '/v1/daily')).status).toBe(405);
    expect((await get(e, '/elsewhere')).status).toBe(404);
    expect((await badge(e)).message).toBe('0');
  });

  it('rate-limits per install id and globally', async () => {
    const e = env({ SUBMIT_LIMITER: limiter(2), GLOBAL_LIMITER: limiter(3) });
    expect((await post(e, payload())).status).toBe(204);
    expect((await post(e, payload())).status).toBe(204);
    expect((await post(e, payload())).status).toBe(429);
    expect((await post(e, payload({ installId: OTHER }))).status).toBe(429);
  });

  it('guards the read route with the bearer token', async () => {
    const e = env();
    expect((await get(e, '/v1/stats')).status).toBe(401);
    expect((await get(e, '/v1/stats', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await get(env({ READ_TOKEN: undefined }), '/v1/stats', { authorization: 'Bearer ' })).status).toBe(401);
    expect((await get(e, '/v1/stats', { authorization: 'Bearer read-secret' })).status).toBe(200);
  });

  it(`deletes per-install rows after ${RETENTION_DAYS} days and keeps the daily totals`, async () => {
    const e = env();
    const old = NOW - (RETENTION_DAYS + 1) * DAY;
    await post(e, payload({ date: utcDate(old), catches: { today: 1, total: 10 }, traps: [{ name: 'amber-gull', today: 1, ...workerProfile() }] }), old);
    await post(e, payload());
    const waits: Promise<unknown>[] = [];
    worker.scheduled({ scheduledTime: NOW, cron: '17 3 * * *' }, e, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const rows = await e.DB.prepare('SELECT date FROM submissions ORDER BY date').all<{ date: string }>();
    expect(rows.results.map((r) => r.date)).toEqual([TODAY]);
    const trapRows = await e.DB.prepare('SELECT date, name FROM trap_submissions ORDER BY date').all<{ date: string; name: string }>();
    expect(trapRows.results).toEqual([{ date: TODAY, name: 'kind-crab' }]);
    const s = await stats(e, RETENTION_DAYS + 5);
    expect(s.days.map((d) => d.date)).toEqual([utcDate(old), TODAY]);
    expect(s.totalCatches).toBe(40);
    // The table keeps no IP or request metadata column.
    const cols = await e.DB.prepare("SELECT name FROM pragma_table_info('submissions')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual(['install_id', 'date', 'version', 'os', 'arch', 'catches_today', 'total_catches', 'helm']);
  });

  it('replaces the per-trap snapshot atomically and keeps totals independent of it', async () => {
    const e = env();
    await post(e, payload());
    await post(e, payload());
    expect((await e.DB.prepare('SELECT name, catches_today FROM trap_submissions').all()).results).toEqual([{ name: 'kind-crab', catches_today: 2 }]);
    await post(e, payload({ traps: [{ name: 'amber-gull', today: 1, ...workerProfile() }] }));
    expect((await e.DB.prepare('SELECT name FROM trap_submissions').all()).results).toEqual([{ name: 'amber-gull' }]);
    await post(e, payload({ traps: [] }));
    expect((await e.DB.prepare('SELECT name FROM trap_submissions').all()).results).toEqual([]);
    expect((await badge(e)).message).toBe('40');
    const cols = await e.DB.prepare("SELECT name FROM pragma_table_info('daily_totals')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual(['date', 'active_installs', 'catches_today', 'new_catches']);
  });

  it('rolls back the install and totals if the per-trap write fails', async () => {
    const e = env();
    await e.DB.prepare("CREATE TRIGGER fail_trap BEFORE INSERT ON trap_submissions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").run();
    expect((await post(e, payload())).status).toBe(500);
    expect((await e.DB.prepare('SELECT install_id FROM submissions').all()).results).toEqual([]);
    expect((await e.DB.prepare('SELECT name FROM trap_submissions').all()).results).toEqual([]);
    expect((await badge(e)).message).toBe('0');
  });
});
