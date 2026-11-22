import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { GlassCard } from '../../../packages/core/src/backend-model.js';
import { SlackApi } from '../src/slack-api.js';
import { SlackOutbox, slackSchema } from '../src/slack-outbox.js';

const message = { text: 'Decision: Ship it?', blocks: [], unfurl_links: false as const, unfurl_media: false as const };

afterEach(() => vi.restoreAllMocks());

it('calls the runtime’s own fetch, so workerd never refuses it as an illegal invocation', async () => {
  // No fetcher and no mock: the real global fetch, aimed at a port nothing listens on.
  const outcome = await new SlackApi('xoxb-test', undefined, 'http://127.0.0.1:9/api/').post('D1', message);
  expect(outcome.kind).toBe('unknown');
  expect(outcome).not.toMatchObject({ reason: 'TypeError' });
});

it('logs each call’s method and outcome, never the token or the message', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const reply = (body: unknown) => async () => Response.json(body);
  await new SlackApi('xoxb-secret-token', reply({ ok: true, ts: '1.2' })).post('D1', message);
  await new SlackApi('xoxb-secret-token', reply({ ok: false, error: 'channel_not_found' })).update('D1', '1.2', message);
  const lines = log.mock.calls.map((c) => String(c[0]));
  expect(lines.map((l) => JSON.parse(l))).toEqual([
    { slack: 'chat.postMessage', ok: true, outcome: 'sent' },
    { slack: 'chat.update', ok: false, outcome: 'refused', error: 'channel_not_found' },
  ]);
  for (const line of lines) expect(line).not.toMatch(/xoxb-secret-token|Ship it/);
});

it('reads a reaction’s reply, which names no message: done, already there, or refused without the scope', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const bodies: unknown[] = [];
  const reply = (body: unknown) => async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return Response.json(body); };
  expect(await new SlackApi('xoxb-test', reply({ ok: true })).react('D1', '1700000000.000100', 'star')).toEqual({ kind: 'sent', ts: '1700000000.000100' });
  expect(bodies).toEqual([{ channel: 'D1', timestamp: '1700000000.000100', name: 'star' }]);
  expect(await new SlackApi('xoxb-test', reply({ ok: false, error: 'already_reacted' })).react('D1', '1.2', 'star')).toEqual({ kind: 'sent', ts: '1.2' });
  expect(await new SlackApi('xoxb-test', reply({ ok: false, error: 'missing_scope', needed: 'reactions:write' })).react('D1', '1.2', 'star')).toEqual({ kind: 'refused', reason: 'missing_scope' });
  // A post's reply must still name its message.
  expect((await new SlackApi('xoxb-test', reply({ ok: true })).post('D1', message)).kind).toBe('later');
});

const card = (seq: number, title: string) => ({
  id: `c${seq}`, family: 'decision', title, grounds: 'home', summary: '', actions: [], links: [], revision: 1,
  observedAt: '2026-11-22T06:00:00.000Z', sourceAt: '2026-11-22T06:00:00.000Z',
}) as unknown as GlassCard;

it('a delivery that throws waits its backoff and the drain still sends the rest', async () => {
  const posted: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    posted.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true, ts: `1.${posted.length}` });
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await runInDurableObject(env.ACCOUNTS.getByName('slack-api-drain'), async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(slackSchema);
    const good = card(2, 'Ship the mirror cards?');
    const outbox = new SlackOutbox(sql, {
      glassOrigin: 'https://glass.test',
      card: (seq) => { if (seq === 1) throw new TypeError('render failed'); return seq === 2 ? good : undefined; },
      token: async () => 'xoxb-test',
      controllable: () => [],
      pause: async () => {},
    });
    outbox.link('p1', { team: 'T1', slackUser: 'U1', channel: 'D1', linkedAt: '2026-11-22T06:00:00.000Z' }, [], Date.now());
    sql.exec('INSERT INTO slack_deliveries(card,person,want,next_at) VALUES (1,?,1,0),(2,?,1,0)', 'p1', 'p1');
    const before = Date.now();
    await outbox.drain();
    const rows = sql.exec<{ card: number; sent: number; attempts: number; next_at: number; error: string | null }>('SELECT card, sent, attempts, next_at, error FROM slack_deliveries ORDER BY card').toArray();
    expect(rows[0]).toMatchObject({ card: 1, sent: 0, attempts: 1, error: 'failed: TypeError' });
    expect(rows[0]!.next_at).toBeGreaterThan(before);
    expect(rows[1]).toMatchObject({ card: 2, sent: 1, error: null });
  });
  expect(posted).toHaveLength(1);
});
