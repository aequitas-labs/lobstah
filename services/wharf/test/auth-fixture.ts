import { env } from 'cloudflare:test';
import { getMigrations } from 'better-auth/db/migration';
import { wharfAuth } from '../src/auth.js';

export async function authFixtures() {
  const auth = wharfAuth(env);
  await (await getMigrations(auth.options)).runMigrations();
  await env.AUTH_DB.exec('CREATE TABLE IF NOT EXISTS deletionReceipt (account text primary key, credentialHash text not null, keyHash text not null)');
  await env.AUTH_DB.exec('DELETE FROM deletionReceipt');
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
