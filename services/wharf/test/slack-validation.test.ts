import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../src/account.js';
import { glassTables } from '../src/glass-state.js';
import { sealToken } from '../src/slack-install.js';
import { SLACK_BUDGET } from '../src/slack-render.js';
import { authFixtures } from './auth-fixture.js';
import { GLASS_CARD_FAMILIES } from '../../../packages/core/src/backend-model.js';
import type { GlassCard, GlassCardAction, WharfDocument, WharfHumanRequest } from '../../../packages/core/src/backend-model.js';

/**
 * The plan's step 4 gates, end to end on one account: every family and
 * action, glass/Slack races, wrong-owner and stale callbacks, Slack outages,
 * a sleeping helm, replays, and the same helm wakes whichever surface
 * answered.
 */
let sequence = 0;
const person = 'test-helm-a';
const call = (path: string, body?: unknown, token = person, session = 'helm') => SELF.fetch(`https://state.test/v1/accounts/a/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lobstah-Helm': session, 'Idempotency-Key': `gate-${++sequence}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sql = async (statement: string, ...bindings: SqlStorageValue[]) => runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => state.storage.sql.exec(statement, ...bindings).toArray());
const encode = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
async function signed(path: string, body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', encode('stub-signing-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { ts, signature: `v0=${hex(await crypto.subtle.sign('HMAC', key, encode(`v0:${ts}:${body}`)))}`, body, path };
}
const send = (s: { ts: string; signature: string; body: string; path: string }) =>
  SELF.fetch(`https://state.test${s.path}`, { method: 'POST', headers: { 'X-Slack-Request-Timestamp': s.ts, 'X-Slack-Signature': s.signature }, body: s.body });
const pressBody = (value: string, user = 'U1') => `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', trigger_id: 't', team: { id: 'T1' }, user: { id: user }, container: { channel_id: 'D1' }, actions: [{ value }] }))}`;
const press = async (value: string, user = 'U1') => send(await signed('/slack/interactions', pressBody(value, user)));
const deliver = () => env.ACCOUNTS.getByName('a').deliverSlack();
type Element = { text: { text: string }; value?: string; url?: string };
type Block = { type: string; text?: { text: string }; elements?: Array<Element | { text: string }> };
type Posted = { method: string; body: { channel?: string; ts?: string; text: string; blocks: Block[] } };
let posted: Posted[] = [];
let slackDown = false;
beforeEach(async () => {
  await authFixtures();
  await runInDurableObject(env.ACCOUNTS.getByName('a'), (_instance: Account, state) => {
    for (const table of ['boats', 'boat_permissions', 'workers', 'worker_nicknames', 'unservable', 'dispatches', 'reports', 'events', 'event_details', 'idem', 'recoveries', 'claims', 'messages', 'files', ...glassTables]) state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec("DELETE FROM meta WHERE key<>'generation'");
    // Request counts live in the instance's memory, not in meta.
    (_instance as unknown as { budgets: Map<string, unknown> }).budgets.clear();
  });
  posted = []; slackDown = false;
  let n = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://slack.com/api/')) return real(input, init);
    if (slackDown) return new Response('upstream error', { status: 503 });
    posted.push({ method: url.slice('https://slack.com/api/'.length), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, ts: `1800000000.${String(++n).padStart(6, '0')}` });
  });
  const linkedAt = '2026-10-30T00:00:00.000Z';
  await env.AUTH_DB.prepare('INSERT INTO slackInstallation VALUES (?,?,?,?,?,?)').bind('T1', 'B1', await sealToken(env, 'xoxb-test'), 'chat:write,im:write,im:history', 'a', linkedAt).run();
  await env.AUTH_DB.prepare('INSERT INTO slackLink VALUES (?,?,?,?,?,NULL)').bind('T1', 'U1', 'a', 'D1', linkedAt).run();
  await env.ACCOUNTS.getByName('a').linkSlack('a', { team: 'T1', slackUser: 'U1', channel: 'D1', grounds: ['away'], linkedAt });
});
afterEach(() => { vi.restoreAllMocks(); });
async function boat(name: string, permissions: string[]) {
  const result = JSON.parse(await env.ACCOUNTS.getByName('a').handle(JSON.stringify({ account: 'a', helm: true, personId: 'a', token: person, method: 'POST', path: 'boats', body: { name, permissions }, key: `issue-${++sequence}` })));
  return result.value as { token: string; id: string };
}
async function helm() {
  const b = await boat(`helm-${++sequence}`, ['work', 'helm']);
  expect((await call('helm/take', { session: 'seat', take: true }, b.token, 'seat')).status).toBe(200);
  return b;
}
async function decision(b: { token: string }, id: string) {
  await call('documents', { id, kind: 'decision', grounds: 'away', title: 'Keep the PR cache?', options: ['Keep the cache', 'Drop the cache'] }, b.token, 'seat');
  await call(`documents/${id}/publish`, {}, b.token, 'seat');
}
/** The newest message of each card, as Slack last received it, by card id. */
async function messages(): Promise<Map<string, Posted>> {
  const rows = await sql('SELECT card, ts FROM slack_deliveries WHERE ts IS NOT NULL') as Array<{ card: number; ts: string }>;
  // The stub answers the k-th Slack call with ts …k: a post is known by that, an edit by the ts it names.
  const latest = new Map<string, Posted>();
  posted.forEach((p, k) => {
    const ts = p.method === 'chat.postMessage' ? `1800000000.${String(k + 1).padStart(6, '0')}` : p.method === 'chat.update' ? p.body.ts : undefined;
    if (ts) latest.set(ts, p);
  });
  return new Map(rows.map((r) => [`c${r.card}`, latest.get(r.ts)!]));
}
const buttons = (m: Posted) => m.body.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements as Element[]);
const section = (m: Posted) => m.body.blocks.find((b) => b.type === 'section')?.text?.text ?? '';
const decisionEvents = async () => (await sql("SELECT count(*) AS n FROM events WHERE kind='decision-answer'"))[0]!.n;

// Every card is posted at Slack's pace, about one a second to a conversation.
it('every family renders within Slack’s limits; each action is a control here or named as the glass’s', { timeout: 60_000 }, async () => {
  const b = await helm(); await decision(b, 'pick');
  const fisher = await boat('fisher', ['work', 'read']);
  const at = new Date().toISOString();
  const every: GlassCardAction[] = [{ kind: 'answer', option: 'One' }, { kind: 'answer', option: `A long option ${'x'.repeat(90)}` }, { kind: 'answer-text' }, { kind: 'allow-once' }, { kind: 'allow-always' }, { kind: 'deny' }, { kind: 'seen' }, { kind: 'message-helm' }, { kind: 'cancel' }, { kind: 'review-dismiss' }, { kind: 'review-mute' }, { kind: 'review-unmute' }];
  const cards = GLASS_CARD_FAMILIES.map((family) => ({ family, key: `k-${family}`, stateHash: 's1', sourceAt: at, title: `${family} <!channel> ${'t'.repeat(200)}`,
    summary: `<@U9> ${'detail '.repeat(330)}`, grounds: 'away', links: [{ label: 'Open PR', url: 'https://github.com/test/repo/pull/7' }], actions: every }));
  expect((await call('cards', { cards }, fisher.token)).status).toBe(200);
  await deliver();
  const all = await (await call('cards')).json<GlassCard[]>();
  const shown = await messages();
  const standing = all.filter((c) => !c.terminal && (c.source !== 'wharf' || c.family === 'decision'));
  expect(new Set(standing.map((c) => c.family))).toEqual(new Set(GLASS_CARD_FAMILIES));
  for (const card of standing) {
    const m = shown.get(card.id)!;
    expect(m, card.id).toBeDefined();
    expect(m.body.blocks.length).toBeLessThanOrEqual(SLACK_BUDGET.blocks);
    expect(m.body.blocks[0]!.text!.text.length).toBeLessThanOrEqual(SLACK_BUDGET.title);
    expect(section(m).length).toBeLessThanOrEqual(SLACK_BUDGET.section);
    expect(m.body.text.length).toBeLessThanOrEqual(SLACK_BUDGET.fallback);
    // Only plain-text fields carry the raw words; everything Slack parses has them escaped.
    expect(m.body.text).not.toMatch(/<!channel>|<@U9>/);
    expect(JSON.stringify(m.body.blocks.filter((b) => b.type !== 'header'))).not.toMatch(/<!channel>|<@U9>/);
    const labels = buttons(m).map((e) => e.text.text);
    expect(labels.every((l) => l.length <= SLACK_BUDGET.buttonLabel)).toBe(true);
    expect(buttons(m).find((e) => e.text.text === 'Open in glass' || e.text.text === 'Answer in glass')?.url).toBe(`https://glass.test/#card/${card.id}`);
    for (const action of card.actions) {
      const here = action.kind === 'answer' ? labels.includes(action.option) || labels.some((l) => /^Option \d$/.test(l))
        : action.kind === 'seen' ? !!buttons(m).find((e) => e.url)?.value
        : action.kind === 'answer-text' ? labels.includes('Answer…')
        : action.kind === 'allow-once' ? labels.includes('Allow once') : action.kind === 'allow-always' ? labels.includes('Allow always') : action.kind === 'deny' ? labels.includes('No')
        : action.kind === 'message-helm' ? labels.includes('Message the helm…')
        : action.kind === 'review-mute' ? labels.includes('Mute this PR')
        : action.kind === 'review-unmute' ? labels.includes('Unmute') : false;
      const named = { 'message-helm': 'message the helm', cancel: 'cancel the job', 'review-dismiss': 'dismiss the review', 'review-mute': 'mute the PR', 'review-unmute': 'unmute the PR' }[action.kind as string];
      expect(here || (named !== undefined && section(m).includes(named)), `${card.family} ${action.kind}`).toBe(true);
    }
  }
});

it('answered in the glass while Slack is down: the same message closes on reconnect, once, and an old button answers nothing', async () => {
  const b = await helm(); await decision(b, 'pick'); await deliver();
  const card = (await (await call('cards')).json<GlassCard[]>()).find((c) => c.family === 'decision')!;
  const before = (await messages()).get(card.id)!;
  const drop = buttons(before).find((e) => e.text.text === 'Drop the cache')!;
  slackDown = true;
  expect((await call('documents/pick/answer', { option: 'Keep the cache' })).status).toBe(200);
  await deliver();
  expect(await sql('SELECT error FROM slack_deliveries WHERE card=?', Number(card.id.slice(1)))).toEqual([{ error: 'http_503' }]);
  slackDown = false;
  await sql('UPDATE slack_deliveries SET next_at=0');
  await deliver();
  const ts = (await sql('SELECT ts FROM slack_deliveries WHERE card=?', Number(card.id.slice(1))))[0]!.ts;
  const edits = posted.filter((p) => p.method === 'chat.update' && p.body.ts === ts);
  expect(edits).toHaveLength(1);
  expect(buttons(edits[0]!).map((e) => e.text.text)).toEqual(['Open in glass']);
  await press(drop.value!);
  expect((await (await call('documents/pick')).json<WharfDocument>()).answer).toMatchObject({ option: 'Keep the cache' });
  expect(await decisionEvents()).toBe(1);
});

it('a Slack answer wakes the helm exactly as a glass answer does; seen wakes no one', async () => {
  const b = await helm(); await decision(b, 'by-slack'); await decision(b, 'by-glass'); await deliver();
  const events = async () => (await sql('SELECT kind FROM events ORDER BY seq')).map((e) => e.kind);
  const start = (await events()).length;
  const cards = await (await call('cards')).json<GlassCard[]>();
  const shown = await messages();
  const slackCard = cards.find((c) => c.key === 'by-slack')!;
  const open = buttons(shown.get(slackCard.id)!).find((e) => e.text.text === 'Open in glass')!;
  await press(open.value!);
  expect((await events()).length).toBe(start);
  await press(buttons(shown.get(slackCard.id)!).find((e) => e.text.text === 'Keep the cache')!.value!);
  expect((await call('documents/by-glass/answer', { option: 'Keep the cache' })).status).toBe(200);
  expect((await events()).slice(start)).toEqual(['decision-answer', 'decision-answer']);
});

it('the same signed press twice is one answer; a copied button from someone else, or after unlinking, does nothing', async () => {
  const b = await helm(); await decision(b, 'pick'); await deliver();
  const card = (await (await call('cards')).json<GlassCard[]>()).find((c) => c.family === 'decision')!;
  const keep = buttons((await messages()).get(card.id)!).find((e) => e.text.text === 'Keep the cache')!;
  await press(keep.value!, 'U2');
  expect((await (await call('documents/pick')).json<WharfDocument>()).answer).toBeUndefined();
  await env.AUTH_DB.prepare('UPDATE slackLink SET revokedAt=? WHERE person=?').bind(new Date().toISOString(), 'a').run();
  await press(keep.value!);
  expect((await (await call('documents/pick')).json<WharfDocument>()).answer).toBeUndefined();
  await env.AUTH_DB.prepare('UPDATE slackLink SET revokedAt=NULL WHERE person=?').bind('a').run();
  const replay = await signed('/slack/interactions', pressBody(keep.value!));
  await send(replay); await send(replay);
  expect((await (await call('documents/pick')).json<WharfDocument>()).answer).toMatchObject({ option: 'Keep the cache' });
  expect(await decisionEvents()).toBe(1);
});

it('asked while the helm sleeps: the receipt says so; when a helm takes its seat it says queued, and one dispatch fulfills it', async () => {
  const dm = JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: 'EvSleep', event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', ts: '1700000000.000100', text: 'Run the nightly cleanup' } });
  await send(await signed('/slack/events', dm)); await send(await signed('/slack/events', dm));
  await deliver();
  const receipt = () => posted.filter((p) => p.body.text?.startsWith('Request:')).at(-1)!;
  expect(section(receipt())).toContain('Received · waiting for the helm');
  const b = await helm();
  await deliver();
  expect(receipt().method).toBe('chat.update');
  expect(section(receipt())).toContain('Received · queued for the helm');
  const [request] = await (await call('requests')).json<WharfHumanRequest[]>();
  expect((await call('dispatches', { id: 'nightly', grounds: 'away', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'Run the nightly cleanup', request: request!.id }, b.token, 'seat')).status).toBe(200);
  expect((await call('dispatches', { id: 'nightly-2', grounds: 'away', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'again', request: request!.id }, b.token, 'seat')).status).toBe(409);
  await deliver();
  expect(section(receipt())).toContain('Dispatched as nightly');
});

it('delivers decisions and PR watches only for the link’s chosen grounds', async () => {
  const b = await helm();
  for (const grounds of ['away', 'home']) {
    expect((await call('documents', { id: `${grounds}-decision`, kind: 'decision', grounds, title: `${grounds} decision`, options: ['Yes'] }, b.token, 'seat')).status).toBe(200);
    await call(`documents/${grounds}-decision/publish`, {}, b.token, 'seat');
  }
  const sourceAt = new Date().toISOString();
  expect((await call('cards', { cards: [
    { family: 'pr', key: 'away-pr', grounds: 'away', title: 'Allowed PR watch', stateHash: 'open', sourceAt, actions: [{ kind: 'seen' }] },
    { family: 'pr', key: 'home-pr', grounds: 'home', title: 'Unbound PR watch', stateHash: 'open', sourceAt, actions: [{ kind: 'seen' }] },
    { family: 'notice', key: 'unknown', title: 'Unassigned notice', stateHash: 'standing', sourceAt },
  ] }, b.token, 'seat')).status).toBe(200);
  await deliver();
  const deliveries = await sql('SELECT c.data FROM slack_deliveries d JOIN cards c ON c.seq=d.card');
  expect(deliveries.length).toBeGreaterThanOrEqual(2);
  expect(deliveries.every((row) => JSON.parse(String(row.data)).grounds === 'away')).toBe(true);
  expect(posted.some((message) => message.body.text.includes('Allowed PR watch'))).toBe(true);
  expect(posted.some((message) => message.body.text.includes('Unbound PR watch') || message.body.text.includes('home decision') || message.body.text.includes('Unassigned notice'))).toBe(false);
});

it('keeps a dispatch’s document on its owning grounds', async () => {
  const b = await helm();
  await call('dispatches', { id: 'owned-job', grounds: 'away', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'Scoped work' }, b.token, 'seat');
  expect((await call('documents', { id: 'wrong-ground', kind: 'decision', title: 'Choose', dispatch: 'owned-job', grounds: 'home' }, b.token, 'seat')).status).toBe(400);
  expect((await call('documents', { id: 'owned-question', kind: 'decision', title: 'Choose', dispatch: 'owned-job' }, b.token, 'seat')).status).toBe(200);
  expect(await (await call('documents/owned-question')).json()).toMatchObject({ grounds: 'away' });
});

it('rebinding stops queued deliveries, old buttons and pending boat answers for removed grounds', async () => {
  const b = await helm();
  const permission = { family: 'permission', key: 'permission-away', grounds: 'away', title: 'Allow deployment', stateHash: 'ask', sourceAt: new Date().toISOString(), actions: [{ kind: 'allow-once' }] };
  expect((await call('cards', { cards: [permission] }, b.token, 'seat')).status).toBe(200);
  await deliver();
  const handle = (await sql("SELECT handle FROM slack_actions WHERE action=?", JSON.stringify({ kind: 'allow-once' })))[0]!.handle as string;
  await press(handle);
  expect(await (await call('cards/answers', undefined, b.token)).json()).toHaveLength(1);
  await env.ACCOUNTS.getByName('a').linkSlack('a', { team: 'T1', slackUser: 'U1', channel: 'D1', linkedAt: new Date().toISOString(), grounds: ['home'] });
  await press(handle);
  expect(await (await call('cards/answers', undefined, b.token)).json()).toEqual([]);
  expect(await sql("SELECT json_extract(data,'$.state') AS state FROM card_answers")).toEqual([{ state: 'refused' }]);
  const sent = posted.length;
  await call('cards', { cards: [{ ...permission, stateHash: 'ask-again' }] }, b.token, 'seat');
  await deliver();
  expect(posted).toHaveLength(sent);
  expect(await sql('SELECT * FROM slack_deliveries')).toEqual([]);
});

it('asks which linked grounds should handle an ambiguous DM before waking or dispatching', async () => {
  await env.ACCOUNTS.getByName('a').linkSlack('a', { team: 'T1', slackUser: 'U1', channel: 'D1', linkedAt: new Date().toISOString(), grounds: ['away', 'home'] });
  const message = async (ts: string, text: string, threadTs?: string) => send(await signed('/slack/events', JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: `Ev${ts.replace('.', '')}`, event: {
    type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', ts, text, ...(threadTs ? { thread_ts: threadTs } : {}),
  } })));
  const top = '1700000000.000100';
  expect((await message(top, 'Investigate the build')).status).toBe(200);
  expect(await (await call('requests')).json()).toEqual([]);
  expect(await sql("SELECT kind FROM events WHERE kind='human-request'")).toEqual([]);
  expect(posted.at(-1)!.body.text).toContain('Which grounds');
  expect(posted.at(-1)!.body.text).toContain('away, home');
  const prompts = posted.length;
  await message(top, 'Investigate the build');
  expect(posted).toHaveLength(prompts);
  await message('1700000000.000200', 'private', top);
  expect(await (await call('requests')).json()).toEqual([]);
  await message('1700000000.000300', 'home', top);
  await message('1700000000.000300', 'home', top);
  const requests = await (await call('requests')).json<WharfHumanRequest[]>();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ grounds: 'home', text: 'Investigate the build', kind: 'work' });
  expect(requests[0]!.followUps).toBeUndefined();
  await env.ACCOUNTS.getByName('a').linkSlack('a', { team: 'T1', slackUser: 'U1', channel: 'D1', linkedAt: new Date().toISOString(), grounds: ['away'] });
  await message('1700000000.000400', 'A follow-up after removing home', top);
  expect((await (await call('requests')).json<WharfHumanRequest[]>())[0]!.followUps).toBeUndefined();
  const b = await helm();
  const dispatch = { id: 'selected-job', repo: 'repo', repoRemote: 'github.com/test/repo', brief: 'Investigate the build', request: requests[0]!.id };
  expect((await call('dispatches', { ...dispatch, grounds: 'away' }, b.token, 'seat')).status).toBe(400);
  expect((await call('dispatches', { ...dispatch, grounds: 'home' }, b.token, 'seat')).status).toBe(200);
});
