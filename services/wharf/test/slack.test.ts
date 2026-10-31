import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { renderCard, slackEscape, SLACK_BUDGET, trimAtBoundary } from '../src/slack-render.js';
import { authFixtures } from './auth-fixture.js';
import type { GlassCard } from '../../../packages/core/src/backend-model.js';

let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person, session = 'helm') => SELF.fetch(`https://state.test/v1/accounts/a/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': session, 'Idempotency-Key': `slack-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sql = async (statement: string, ...bindings: SqlStorageValue[]) => runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => state.storage.sql.exec(statement, ...bindings).toArray());
const deliver = () => env.ACCOUNTS.getByName('a').deliverSlack();
type SlackCall = { method: string; body: { channel: string; ts?: string; text: string; blocks: Array<{ type: string; text?: { text: string }; elements?: Array<{ text: string | { text: string }; url?: string }> }> } };
let slack: SlackCall[] = [];
let answer: (method: string) => Response;
beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files', ...glassTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
  });
  slack = [];
  let ts = 0;
  answer = () => Response.json({ ok: true, ts: `1700000000.${String(++ts).padStart(6, '0')}` });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://slack.com/api/')) return real(input, init);
    const method = url.slice('https://slack.com/api/'.length);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer xoxb-test-only-not-a-real-token');
    slack.push({ method, body: JSON.parse(String(init?.body)) });
    return answer(method);
  });
});
afterEach(() => { vi.restoreAllMocks(); });
async function link() {
  await sql("INSERT INTO slack_links VALUES ('a','T1','U1','D1','2026-10-30T00:00:00.000Z',NULL)");
}
async function helm() {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name: 'helm-boat', permissions: ['work', 'helm'] }, key: `issue-${++sequence}` })));
  expect(result.status).toBe(201); const b = result.value as { token: string };
  expect((await call('helm/take', { session: 'seat' }, b.token, 'seat')).status).toBe(200);
  return b;
}
async function decision(b: { token: string }, id: string) {
  expect((await call('documents', { id, kind: 'decision', title: 'Choose a direction', options: ['Keep the cache', 'Drop the cache'] }, b.token, 'seat')).status).toBe(200);
  expect((await call(`documents/${id}/publish`, {}, b.token, 'seat')).status).toBe(200);
}
const blockText = (c: SlackCall) => c.body.blocks.map((b) => [b.text?.text, ...(b.elements ?? []).map((e) => (typeof e.text === 'string' ? e.text : e.text.text))].join(' ')).join('\n');
const decisionPosts = () => slack.filter((c) => c.body.text.startsWith('Decision:'));

it('answer in glass first: the same private Slack message closes, showing the winner, with nothing left to press', async () => {
  await link(); const b = await helm(); await decision(b, 'pick');
  await deliver();
  const posted = decisionPosts();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ method: 'chat.postMessage', body: { channel: 'D1', unfurl_links: false, unfurl_media: false } });
  const card = (await (await call('cards')).json<GlassCard[]>()).find((c) => c.family === 'decision')!;
  expect(blockText(posted[0]!)).toContain('1. Keep the cache\n2. Drop the cache');
  expect(posted[0]!.body.blocks.at(-1)!.elements![0]).toMatchObject({ text: { text: 'Answer in glass' }, url: `https://glass.test/#card/${card.id}` });
  const ts = (await sql('SELECT ts FROM slack_deliveries WHERE card=?', Number(card.id.slice(1))))[0]!.ts;

  // The answer is made in the glass. Nothing is clicked in Slack for its card to close.
  expect((await call('documents/pick/answer', { option: 'Drop the cache' })).status).toBe(200);
  await deliver();
  const edits = decisionPosts().slice(1);
  expect(edits).toHaveLength(1);
  expect(edits[0]).toMatchObject({ method: 'chat.update', body: { channel: 'D1', ts } });
  expect(blockText(edits[0]!)).toMatch(/Answered · .* · Drop the cache · by a/);
  expect(blockText(edits[0]!)).not.toContain('1. Keep the cache');
  expect(edits[0]!.body.blocks.at(-1)!.elements!.map((e) => (e.text as { text: string }).text)).toEqual(['Open in glass']);
  // A drain with nothing new sends nothing, and the answer was recorded once.
  await deliver();
  expect(decisionPosts()).toHaveLength(2);
  expect((await (await call('documents/pick')).json<{ answer: { option: string } }>()).answer.option).toBe('Drop the cache');
});

it('a rate-limited edit retries the projection after Slack’s wait, never the answer', async () => {
  await link(); const b = await helm(); await decision(b, 'pick'); await deliver();
  answer = (method) => (method === 'chat.update' ? new Response('', { status: 429, headers: { 'Retry-After': '30' } }) : Response.json({ ok: true, ts: '1.1' }));
  expect((await call('documents/pick/answer', { option: 'Keep the cache' })).status).toBe(200);
  await deliver();
  const [held] = await sql("SELECT want>sent AS due,error,next_at FROM slack_deliveries WHERE error IS NOT NULL");
  expect(held).toMatchObject({ due: 1, error: 'rate_limited' });
  expect(Number(held!.next_at)).toBeGreaterThan(Date.now() + 25_000);
  // Nothing goes out before the wait is over.
  const before = slack.length; await deliver(); expect(slack).toHaveLength(before);
  answer = () => Response.json({ ok: true, ts: '1.1' });
  await sql('UPDATE slack_deliveries SET next_at=0 WHERE error IS NOT NULL');
  await deliver();
  expect(slack.filter((c) => c.method === 'chat.update' && c.body.text.startsWith('Decision:'))).toHaveLength(2);
  expect(await sql('SELECT count(*) AS n FROM documents WHERE json_extract(data,\'$.answer.option\')=\'Keep the cache\'')).toEqual([{ n: 1 }]);
});

it('a standing card whose message was deleted is posted again; a refused credential stops sending; nobody unlinked is sent anything', async () => {
  const b = await helm(); await decision(b, 'first'); await deliver();
  expect(slack).toHaveLength(0);
  await link(); await decision(b, 'second'); await deliver();
  // Only cards that moved after linking are delivered.
  expect(decisionPosts()).toHaveLength(1);
  answer = (method) => (method === 'chat.update' ? Response.json({ ok: false, error: 'message_not_found' }) : Response.json({ ok: true, ts: '2.2' }));
  // Seeing it changes the card; its message is gone, so the card is posted again, still standing.
  expect((await call('documents/second/ack', {})).status).toBe(200);
  await deliver();
  expect(decisionPosts().map((c) => c.method)).toEqual(['chat.postMessage', 'chat.update', 'chat.postMessage']);
  expect(blockText(decisionPosts().at(-1)!)).toContain('Seen by');
  answer = () => Response.json({ ok: true, ts: '2.2' });
  expect((await call('documents/second/answer', { text: 'neither' })).status).toBe(200);
  await deliver();
  expect(decisionPosts().at(-1)).toMatchObject({ method: 'chat.update', body: { ts: '2.2' } });
  answer = () => Response.json({ ok: false, error: 'token_revoked' });
  await decision(b, 'third'); await deliver();
  expect(await sql("SELECT error FROM slack_deliveries WHERE error LIKE 'refused%'")).toEqual([{ error: 'refused: token_revoked' }]);
  // A refused delivery stays stopped through later changes to its card.
  const tried = slack.length;
  expect((await call('documents/third/ack', {})).status).toBe(200); await deliver();
  expect(slack.length).toBe(tried);
  await sql("UPDATE slack_links SET revoked_at='2026-10-30T01:00:00.000Z'");
  await decision(b, 'fourth'); await deliver();
  expect(slack.length).toBe(tried);
});

it('renders within Slack’s limits and never lets card text mention anyone or forge a link', () => {
  const card: GlassCard = {
    id: 'c9', source: 'boat:b1', family: 'permission', key: 'grant:1', revision: 1, stateHash: 'x', sourceAt: '2026-10-30T12:00:00.000Z', observedAt: '2026-10-30T12:00:00.000Z',
    title: `Allow <!channel> ${'x'.repeat(400)}`, summary: `<@U123> asked <https://evil.test|click> & ${'word '.repeat(900)}`,
    links: Array.from({ length: 8 }, (_, i) => ({ label: `Link ${i} ${'y'.repeat(100)}`, url: `https://example.test/${i}` })),
    actions: [{ kind: 'allow-once' }, { kind: 'allow-always' }, { kind: 'deny' }],
  };
  const m = renderCard(card, 'https://glass.test');
  const header = m.blocks[0] as { text: { text: string } };
  expect(header.text.text.length).toBeLessThanOrEqual(SLACK_BUDGET.title);
  expect(m.blocks.length).toBeLessThanOrEqual(SLACK_BUDGET.blocks);
  const section = m.blocks.find((x) => x.type === 'section') as { text: { text: string } };
  expect(section.text.text.length).toBeLessThanOrEqual(SLACK_BUDGET.section);
  expect(section.text.text).toContain('&lt;@U123&gt; asked &lt;https://evil.test|click&gt; &amp;');
  expect(section.text.text).toMatch(/_Excerpt · read the full card in the glass_ \(\d+ characters not shown\)\n\n/);
  // A long summary gives way; what the card asks never does.
  expect(section.text.text.endsWith('Allow once, Allow always or No.')).toBe(true);
  expect(m.text.length).toBeLessThanOrEqual(SLACK_BUDGET.fallback);
  const buttons = (m.blocks.at(-1) as { elements: Array<{ text: { text: string } }> }).elements;
  expect(buttons).toHaveLength(1 + SLACK_BUDGET.linkButtons);
  expect(buttons.every((x) => x.text.text.length <= SLACK_BUDGET.buttonLabel)).toBe(true);
  expect(slackEscape('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  expect(trimAtBoundary('one two three', 9)).toEqual({ text: 'one two', omitted: 6 });
});
