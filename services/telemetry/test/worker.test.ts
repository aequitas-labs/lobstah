import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import type { D1Database, D1PreparedStatement, D1Result, Env, RateLimit } from '../src/bindings.js';
import worker, { FIELDS, RETENTION_DAYS, handle, utcDate, validate } from '../src/index.js';

// The client's allowed keys and the Worker's must be the same list.
import { TELEMETRY_FIELDS } from '../../../packages/core/src/telemetry.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const TODAY = utcDate(NOW);
const ID = '3b0c8f9e-6a1d-4c2e-9f3a-1b2c3d4e5f60';
const OTHER = '7e1d2c3b-4a5f-4e6d-8c7b-0a9f8e7d6c5b';

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 1, version: '0.6.9', os: 'macos', arch: 'arm64', installId: ID, date: TODAY, catchesToday: 3, totalCatches: 40, ...over };
}

describe('telemetry Worker validation', () => {
  it('accepts exactly the client payload fields', () => {
    expect([...FIELDS]).toEqual([...TELEMETRY_FIELDS]);
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
    ['a fractional count', { catchesToday: 1.5 }],
    ['a negative count', { totalCatches: -1 }],
    ['a string count', { totalCatches: '40' }],
    ['a huge count', { totalCatches: 1e12 }],
    ['today above the total', { catchesToday: 41 }],
  ])('rejects %s', (_name, over) => {
    expect(validate(payload(over), NOW)).toMatchObject({ ok: false });
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
    await post(e, payload({ date: utcDate(NOW - DAY), catchesToday: 1, totalCatches: 37 }), NOW - DAY);
    await post(e, payload());
    await post(e, payload({ installId: OTHER, catchesToday: 2, totalCatches: 5 }));
    // A later same-day submission with higher counts adds only the difference.
    await post(e, payload({ installId: OTHER, catchesToday: 4, totalCatches: 7 }));
    // A total that went down (a reset store) adds nothing.
    await post(e, payload({ date: utcDate(NOW + DAY), catchesToday: 0, totalCatches: 10 }), NOW + DAY);
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
    expect((await post(e, JSON.stringify({ ...payload(), pad: 'x'.repeat(2000) }))).status).toBe(413);
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
    await post(e, payload({ date: utcDate(old), totalCatches: 10, catchesToday: 1 }), old);
    await post(e, payload());
    const waits: Promise<unknown>[] = [];
    worker.scheduled({ scheduledTime: NOW, cron: '17 3 * * *' }, e, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const rows = await e.DB.prepare('SELECT date FROM submissions ORDER BY date').all<{ date: string }>();
    expect(rows.results.map((r) => r.date)).toEqual([TODAY]);
    const s = await stats(e, RETENTION_DAYS + 5);
    expect(s.days.map((d) => d.date)).toEqual([utcDate(old), TODAY]);
    expect(s.totalCatches).toBe(40);
    // The table keeps no IP or request metadata column.
    const cols = await e.DB.prepare("SELECT name FROM pragma_table_info('submissions')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual(['install_id', 'date', 'version', 'os', 'arch', 'catches_today', 'total_catches']);
  });

  it('forgets an install on request, keeping the daily totals', async () => {
    const e = env();
    await post(e, payload());
    await post(e, payload({ installId: OTHER }));
    const del = (id: string) => handle(new Request(`https://t.example/v1/installs/${id}`, { method: 'DELETE' }), e, NOW);
    expect((await del('not-a-uuid')).status).toBe(400);
    expect((await del(ID)).status).toBe(204);
    const rows = await e.DB.prepare('SELECT install_id FROM submissions').all<{ install_id: string }>();
    expect(rows.results.map((r) => r.install_id)).toEqual([OTHER]);
    expect((await badge(e)).message).toBe('80');
  });
});
