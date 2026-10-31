import { boundedBody, requireThat } from './protocol.js';
import type { SlackEnv } from './slack-install.js';

/** Slack signs each request with its time; one older or newer than five minutes is refused. */
const SKEW_SECONDS = 300;
/** Slack's payloads are small; a DM message is at most 40,000 characters. */
const BODY_MAX = 196_608;
const encode = (s: string) => new TextEncoder().encode(s);
const hexOf = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

/**
 * Slack's v0 signature over the exact bytes received, checked before anything
 * is parsed: HMAC-SHA256 of `v0:<timestamp>:<body>` under the app's signing
 * secret, compared in constant time. Returns the body as text.
 */
export async function verifySlack(env: SlackEnv, request: Request, now = Date.now()): Promise<string> {
  requireThat(env.SLACK_SIGNING_SECRET, 404, 'route not found');
  const raw = await boundedBody(request, BODY_MAX);
  const ts = request.headers.get('X-Slack-Request-Timestamp') ?? '', signature = request.headers.get('X-Slack-Signature') ?? '';
  requireThat(/^\d{1,12}$/.test(ts) && Math.abs(now / 1000 - Number(ts)) <= SKEW_SECONDS, 401, 'stale or missing Slack timestamp');
  const key = await crypto.subtle.importKey('raw', encode(env.SLACK_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(encode(`v0:${ts}:`).length + raw.length);
  signed.set(encode(`v0:${ts}:`)); signed.set(raw, encode(`v0:${ts}:`).length);
  const expected = `v0=${hexOf(new Uint8Array(await crypto.subtle.sign('HMAC', key, signed)))}`;
  requireThat(signature.length === expected.length && crypto.subtle.timingSafeEqual(encode(signature), encode(expected)), 401, 'invalid Slack signature');
  return new TextDecoder().decode(raw);
}

/** A DM message from a linked person, as the account records it. */
export interface SlackMessageIn {
  eventId: string;
  team: string;
  user: string;
  channel: string;
  ts: string;
  /** Set when the message is a reply in a thread: the thread's first message. */
  threadTs?: string;
  text: string;
}
type SlackEvent = { type?: unknown; challenge?: unknown; team_id?: unknown; event_id?: unknown; event?: Record<string, unknown> };
const ok = () => new Response(null, { status: 200 });
const id = (v: unknown, pattern = /^[A-Z0-9]{1,32}$/) => (typeof v === 'string' && pattern.test(v) ? v : undefined);
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;

/**
 * The Slack app's HTTPS ingress on the API host. Every request is verified
 * first and answered quickly; work is recorded before Slack is told it
 * arrived, and nothing here runs work. A message counts only from a linked
 * person, in their own DM with the app; anything else is acknowledged and
 * ignored. Card controls are links into the glass in this release, so an
 * interaction is acknowledged and changes nothing.
 */
export async function slackIngress(request: Request, env: SlackEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  requireThat(request.method === 'POST' && (path === '/slack/events' || path === '/slack/interactions'), 404, 'route not found');
  const raw = await verifySlack(env, request);
  if (path === '/slack/interactions') return ok();
  let body: SlackEvent;
  try { body = JSON.parse(raw); } catch { return new Response('invalid JSON', { status: 400 }); }
  if (body.type === 'url_verification' && typeof body.challenge === 'string') return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } });
  if (body.type !== 'event_callback') return ok();
  const e = body.event ?? {};
  const team = id(body.team_id), eventId = id(body.event_id, /^[A-Za-z0-9]{1,64}$/), user = id(e.user), channel = id(e.channel), ts = typeof e.ts === 'string' && SLACK_TS.test(e.ts) ? e.ts : undefined;
  // A person's own words only: no edits, joins, bot posts (ours included) or files without text.
  if (e.type !== 'message' || e.channel_type !== 'im' || e.subtype !== undefined || e.bot_id !== undefined || typeof e.text !== 'string' || !e.text.trim()) return ok();
  if (!team || !eventId || !user || !channel || !ts) return ok();
  const installed = await env.AUTH_DB.prepare('SELECT botUser FROM slackInstallation WHERE team=?').bind(team).first<{ botUser: string }>();
  if (!installed || installed.botUser === user) return ok();
  const link = await env.AUTH_DB.prepare('SELECT person,channel FROM slackLink WHERE team=? AND slackUser=? AND revokedAt IS NULL').bind(team, user).first<{ person: string; channel: string }>();
  // Only the linked person, in the DM the app opened with them.
  if (!link || link.channel !== channel) return ok();
  const threadTs = typeof e.thread_ts === 'string' && SLACK_TS.test(e.thread_ts) && e.thread_ts !== ts ? e.thread_ts : undefined;
  await env.ACCOUNTS.getByName(link.person).slackMessage(link.person, { eventId, team, user, channel, ts, ...(threadTs ? { threadTs } : {}), text: e.text.slice(0, 16000) });
  return ok();
}
