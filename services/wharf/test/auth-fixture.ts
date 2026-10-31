import { env } from 'cloudflare:test';
import { getMigrations } from 'better-auth/db/migration';
import { wharfAuth } from '../src/auth.js';
import slackSchema from '../migrations/0002_slack.sql?raw';

export async function authFixtures() {
  const auth = wharfAuth(env);
  await (await getMigrations(auth.options)).runMigrations();
  await env.AUTH_DB.exec('CREATE TABLE IF NOT EXISTS deletionReceipt (account text primary key, credentialHash text not null, keyHash text not null)');
  await env.AUTH_DB.exec('DELETE FROM deletionReceipt');
  // The Slack tables, from the committed migration, empty for each test.
  const slack = slackSchema.replace(/^--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^CREATE (TABLE|INDEX) /, 'CREATE $1 IF NOT EXISTS '));
  await env.AUTH_DB.batch(slack.map((s) => env.AUTH_DB.prepare(s)));
  for (const table of ['slackInstallation', 'slackLink', 'slackConnect']) await env.AUTH_DB.exec(`DELETE FROM ${table}`);
  // Tests share native D1 storage, but not another test's rate-limit window.
  await env.AUTH_DB.exec('DELETE FROM rateLimit');
  const context = await auth.$context;
  for (const [id, githubId, token] of [['a', '123', 'test-helm-a'], ['b', '456', 'test-helm-b']]) {
    if (!await context.internalAdapter.findUserById(id)) await context.adapter.create({ model: 'user', forceAllowId: true, data: { id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
    await context.adapter.deleteMany({ model: 'account', where: [{ field: 'userId', value: id }] });
    await context.adapter.create({ model: 'account', data: { providerId: 'github', accountId: githubId, userId: id, createdAt: new Date(), updatedAt: new Date() } });
    await context.adapter.deleteMany({ model: 'session', where: [{ field: 'token', value: token }] });
    await context.adapter.create({ model: 'session', data: { token, userId: id, expiresAt: new Date(Date.now() + 3600000), createdAt: new Date(), updatedAt: new Date() } });
  }
}
