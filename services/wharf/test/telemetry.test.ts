import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import initial from '../../telemetry/migrations/0001_init.sql?raw';
import daily from '../../telemetry/migrations/0002_daily_catches.sql?raw';
import usage from '../../telemetry/migrations/0003_wharf_usage.sql?raw';
import { handle, record, validate } from '../../telemetry/src/index.js';

// The receiver's SQL also runs under real Workers/D1, not only node:sqlite.
// This test shares only the throwaway test binding, never a deployed database.
it('validates and atomically retries schema 2 using native Workers D1, without retaining request metadata', async () => {
  for (const migration of [initial, daily, usage]) {
    for (const statement of migration.replace(/^--.*$/gm, '').split(';').filter((s) => s.trim())) await env.AUTH_DB.prepare(statement).run();
  }
  const now = Date.parse('2026-10-11T12:00:00Z');
  const p = { schema: 2, version: '0.7.4', os: 'macos', arch: 'arm64', installId: '3b0c8f9e-6a1d-4c2e-9f3a-1b2c3d4e5f60', date: '2026-10-11',
    catches: { today: 1, total: 10_000_000, withHelm: '1', withoutHelm: '0', helmUnknown: '0', onLocal: '0', onWharf: '1', locationUnknown: '0' },
    helms: 'several', helm: null, traps: [{ name: 'kind-crab', today: 1, harness: 'codex', model: null, config: { effort: null, permissionMode: null } }], byWorker: [],
    grounds: { total: '1', local: '0', wharf: '1' }, wharf: 'self-hosted', boats: '2', boatAccess: { work: true, read: true, helm: false } };
  const result = validate(p, now); expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error);
  const request = new Request('https://telemetry.test/v1/daily', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', 'User-Agent': 'private-account-client' }, body: JSON.stringify(p) });
  expect((await handle(request, { DB: env.AUTH_DB }, now)).status).toBe(204);
  await record(env.AUTH_DB, result.value);
  expect(await env.AUTH_DB.prepare("SELECT installs FROM daily_usage_totals WHERE dimension='boats' AND bucket='2'").first()).toEqual({ installs: 1 });
  const stored = JSON.stringify(await env.AUTH_DB.prepare('SELECT * FROM usage_submissions').all());
  for (const secret of ['192.0.2.1', 'private-account-client', '12:00:00']) expect(stored).not.toContain(secret);

  // Schema 2 adds histograms, not lifetime catches or authentication. Run the
  // public reads through native D1 after all deployed and new migrations.
  const get = (path: string) => handle(new Request(`https://telemetry.test${path}`), { DB: env.AUTH_DB }, now);
  const response = await get('/v1/stats');
  expect(response.status).toBe(200);
  const stats = await response.json() as Record<string, unknown>;
  expect(stats).toMatchObject({ totalCatches: 1, activeBoats: 1, activeTraps: 1 });
  expect(stats.usage).toEqual(expect.arrayContaining([
    { date: p.date, dimension: 'helms', bucket: 'several', installs: 1 },
    { date: p.date, dimension: 'wharf', bucket: 'self-hosted', installs: 1 },
  ]));
  for (const secret of [p.installId, 'kind-crab', 'permissionMode', 'effort']) expect(JSON.stringify(stats)).not.toContain(secret);
  for (const kind of ['boats', 'traps', 'catches']) expect(await (await get(`/badge/${kind}.json`)).json()).toMatchObject({ message: '1' });

  const capped = { ...p, catches: { ...p.catches, today: 10_000, withHelm: '11+', onWharf: '11+' } };
  const submit = (body: unknown) => handle(new Request('https://telemetry.test/v1/daily', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { DB: env.AUTH_DB }, now);
  expect((await submit(capped)).status).toBe(204);
  expect((await submit(capped)).status).toBe(204);
  expect((await submit(p)).status).toBe(204); // a stale snapshot cannot recount or lower the day
  expect((await submit({ ...capped, catches: { ...capped.catches, today: 10_001 } })).status).toBe(400);
  expect(await (await get('/badge/catches.json')).json()).toMatchObject({ message: '10000' });
  expect(await env.AUTH_DB.prepare("SELECT installs FROM daily_usage_totals WHERE dimension='boats' AND bucket='2'").first()).toEqual({ installs: 1 });
});
