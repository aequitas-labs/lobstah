import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { getMigrations } from 'better-auth/db/migration';
import schema from '../migrations/0001_auth.sql?raw';
import { wharfAuth } from '../src/auth.js';

it('the committed authentication migration satisfies the pinned native-D1 schema', async () => {
  // D1 exec treats each line as a statement, including comment-only lines.
  const statements = schema.replace(/^--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
  await env.AUTH_DB.batch(statements.map((sql) => env.AUTH_DB.prepare(sql)));
  const migrations = await getMigrations(wharfAuth(env).options);
  expect(migrations.toBeCreated).toEqual([]);
  expect(migrations.toBeAdded).toEqual([]);
  expect(migrations.toBeAddedIndexes).toEqual([]);
  expect(await env.AUTH_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deletionReceipt'").first()).not.toBeNull();
});
