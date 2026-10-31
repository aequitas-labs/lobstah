import { ApiError, requireThat } from './protocol.js';

/** The Slack app's credentials. The client id is public config; the secrets are optional Worker secrets. */
export type SlackEnv = Env & { SLACK_CLIENT_ID?: string; SLACK_CLIENT_SECRET?: string; SLACK_SIGNING_SECRET?: string };
/** What the selected first release asks of Slack: post and edit in a person's DM with the app, and read what they write there. */
export const SLACK_SCOPES = ['chat:write', 'im:write', 'im:history'] as const;
/** A connect state is good once, for ten minutes, for the browser session that asked for it. */
const CONNECT_MS = 600_000;
const API = 'https://slack.com/api/';

/** One person's link, as the glass shows it and the account's outbox uses it. */
export interface SlackLink { team: string; slackUser: string; channel: string; linkedAt: string }

/** Whether this wharf has a Slack app to connect to. */
export function slackConfigured(env: SlackEnv): boolean {
  return !!env.SLACK_CLIENT_ID && !!env.SLACK_CLIENT_SECRET;
}
const redirectUri = (glass: string) => `${glass}/api/slack/oauth`;

/** A key for sealing bot tokens at rest, derived from the wharf's auth secret for this one purpose. */
async function sealingKey(env: Env): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('lobstah wharf slack bot token') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unbase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** A bot token as stored: AES-GCM under the derived key, with its nonce. */
export async function sealToken(env: Env, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealingKey(env), new TextEncoder().encode(token)));
  return `v1.${base64(iv)}.${base64(sealed)}`;
}
export async function unsealToken(env: Env, stored: string): Promise<string> {
  const [version, iv, sealed] = stored.split('.');
  requireThat(version === 'v1' && iv && sealed, 503, 'stored Slack token is unreadable');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv) }, await sealingKey(env), unbase64(sealed)));
}
/** The bot token for a workspace this app is installed in, or nothing. */
export async function installationToken(env: Env, team: string): Promise<string | undefined> {
  const row = await env.AUTH_DB.prepare('SELECT botToken FROM slackInstallation WHERE team=?').bind(team).first<{ botToken: string }>();
  return row ? unsealToken(env, row.botToken) : undefined;
}

/** A person's live link, if they have one. */
export async function personLink(env: Env, person: string): Promise<SlackLink | undefined> {
  return (await env.AUTH_DB.prepare('SELECT team,slackUser,channel,linkedAt FROM slackLink WHERE person=? AND revokedAt IS NULL').bind(person).first<SlackLink>()) ?? undefined;
}
/** Start connecting: a single-use state bound to this person and browser session, and where to send them. */
export async function connectUrl(env: SlackEnv, glass: string, person: string, sessionId: string): Promise<string> {
  requireThat(slackConfigured(env), 409, 'this wharf has no Slack app configured');
  const state = base64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM slackConnect WHERE expiresAt<?').bind(Date.now()),
    env.AUTH_DB.prepare('INSERT INTO slackConnect VALUES (?,?,?,?)').bind(state, person, sessionId, Date.now() + CONNECT_MS),
  ]);
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', env.SLACK_CLIENT_ID!); url.searchParams.set('scope', SLACK_SCOPES.join(','));
  url.searchParams.set('redirect_uri', redirectUri(glass)); url.searchParams.set('state', state);
  return url.href;
}
async function slackCall<T>(method: string, form: Record<string, string>, token?: string): Promise<T & { ok: boolean; error?: string }> {
  const response = await fetch(API + method, {
    method: 'POST', body: new URLSearchParams(form),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  requireThat(response.ok, 502, `Slack ${method} failed (${response.status})`);
  return response.json();
}
type OAuthAccess = { access_token?: string; token_type?: string; scope?: string; bot_user_id?: string; team?: { id?: string }; authed_user?: { id?: string }; is_enterprise_install?: boolean };
/**
 * Finish connecting. The state must be live, unused, and this same person's
 * and browser session's. The installation's bot token is sealed at rest; the
 * link names this person's own Slack user and the DM the app opens with them.
 * A workspace installation links no one else.
 */
export async function completeConnect(env: SlackEnv, glass: string, person: string, sessionId: string, code: string, state: string): Promise<SlackLink> {
  requireThat(slackConfigured(env), 409, 'this wharf has no Slack app configured');
  const claimed = await env.AUTH_DB.prepare('DELETE FROM slackConnect WHERE state=? RETURNING person,sessionId,expiresAt').bind(state).first<{ person: string; sessionId: string; expiresAt: number }>();
  requireThat(claimed && claimed.expiresAt > Date.now(), 400, 'this Slack connection expired or was already used; connect again from the glass');
  requireThat(claimed.person === person && claimed.sessionId === sessionId, 403, 'this Slack connection was started by another session');
  const access = await slackCall<OAuthAccess>('oauth.v2.access', { client_id: env.SLACK_CLIENT_ID!, client_secret: env.SLACK_CLIENT_SECRET!, code, redirect_uri: redirectUri(glass) });
  requireThat(access.ok, 400, `Slack refused the connection: ${access.error ?? 'unknown error'}`);
  requireThat(!access.is_enterprise_install, 400, 'install the app in one workspace, not an enterprise organization');
  const team = access.team?.id, slackUser = access.authed_user?.id, token = access.access_token, granted = (access.scope ?? '').split(',');
  requireThat(team && slackUser && token && access.token_type === 'bot' && access.bot_user_id, 502, 'Slack returned an incomplete installation');
  requireThat(SLACK_SCOPES.every((s) => granted.includes(s)), 400, `the app needs ${SLACK_SCOPES.join(', ')}`);
  const opened = await slackCall<{ channel?: { id?: string } }>('conversations.open', { users: slackUser }, token);
  requireThat(opened.ok && opened.channel?.id, 502, `Slack would not open your DM with the app: ${opened.error ?? 'no channel'}`);
  const owner = await env.AUTH_DB.prepare('SELECT person FROM slackLink WHERE team=? AND slackUser=? AND revokedAt IS NULL').bind(team, slackUser).first<{ person: string }>();
  requireThat(!owner || owner.person === person, 409, 'that Slack user is linked to another wharf account');
  const link: SlackLink = { team, slackUser, channel: opened.channel.id, linkedAt: new Date().toISOString() };
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('INSERT OR REPLACE INTO slackInstallation VALUES (?,?,?,?,?,?)').bind(team, access.bot_user_id, await sealToken(env, token), granted.join(','), person, link.linkedAt),
    // One link per person: a new link replaces the old one.
    env.AUTH_DB.prepare('UPDATE slackLink SET revokedAt=? WHERE person=? AND revokedAt IS NULL').bind(link.linkedAt, person),
    env.AUTH_DB.prepare('INSERT OR REPLACE INTO slackLink VALUES (?,?,?,?,?,NULL)').bind(team, slackUser, person, link.channel, link.linkedAt),
  ]);
  return link;
}
/** Unlink: nothing more is sent to that Slack user for this person, and their cards stay. */
export async function disconnect(env: Env, person: string): Promise<void> {
  await env.AUTH_DB.prepare('UPDATE slackLink SET revokedAt=? WHERE person=? AND revokedAt IS NULL').bind(new Date().toISOString(), person).run();
}
/** Turn an install error into the glass's message, never a stack trace. */
export function connectError(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Slack connection failed';
}
