import type { SlackMessage } from './slack-render.js';

/**
 * What one Slack Web API call came to. `sent` carries the message's
 * timestamp; `later` says when to try again; `gone` means the message to
 * update no longer exists; `refused` is permanent for this credential or
 * conversation; `unknown` means the call may or may not have landed.
 */
export type SlackOutcome =
  | { kind: 'sent'; ts: string }
  | { kind: 'later'; afterMs: number; reason: string }
  | { kind: 'gone' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unknown'; reason: string };

/** Errors after which retrying with the same token or conversation cannot succeed. */
const REFUSED = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'channel_not_found', 'not_in_channel',
  'is_archived', 'missing_scope', 'no_permission', 'team_access_not_granted', 'user_disabled', 'ekm_access_denied', 'restricted_action', 'org_login_required']);
const GONE = new Set(['message_not_found', 'cant_update_message', 'edit_window_closed']);
const API = 'https://slack.com/api/';
/** One minute, unless Slack names its own wait. */
const DEFAULT_WAIT_MS = 60_000;

/**
 * workerd refuses the native fetch when it is called as another object's
 * method ("Illegal invocation"), so the default calls it on its own.
 */
const globalFetch: typeof fetch = (input, init) => fetch(input, init);

/** One log line per call: the method and how it came out, never the token or the message. */
function logOutcome(method: string, outcome: SlackOutcome) {
  const reason = outcome.kind === 'later' || outcome.kind === 'refused' || outcome.kind === 'unknown' ? outcome.reason : undefined;
  console.log(JSON.stringify({ slack: method, ok: outcome.kind === 'sent', outcome: outcome.kind, ...(reason ? { error: reason } : {}) }));
}

type SlackResult = { ok?: boolean; ts?: unknown; error?: unknown };
/** A post or an edit lands as the message Slack names. */
const messageTs = (result: SlackResult) => (result.ok && typeof result.ts === 'string' ? result.ts : undefined);

/** Posts and edits one bot's messages. Holds the token for one call; never stores or logs it. */
export class SlackApi {
  constructor(private token: string, private fetcher: typeof fetch = globalFetch, private base = API) {}
  post(channel: string, message: SlackMessage, threadTs?: string): Promise<SlackOutcome> { return this.call('chat.postMessage', { channel, ...(threadTs ? { thread_ts: threadTs } : {}), ...message }, messageTs); }
  update(channel: string, ts: string, message: SlackMessage): Promise<SlackOutcome> { return this.call('chat.update', { channel, ts, ...message }, messageTs); }
  /**
   * Add the bot's reaction to one message. Slack's reply names no message,
   * so `sent` carries the one reacted to; a reaction already there is done.
   * An install without `reactions:write` is `refused` with `missing_scope`.
   */
  react(channel: string, ts: string, name: string): Promise<SlackOutcome> {
    return this.call('reactions.add', { channel, timestamp: ts, name }, (result) => (result.ok || result.error === 'already_reacted' ? ts : undefined));
  }
  private async call(method: string, body: Record<string, unknown>, landed: (result: SlackResult) => string | undefined): Promise<SlackOutcome> {
    const outcome = await this.send(method, body, landed);
    logOutcome(method, outcome);
    return outcome;
  }
  private async send(method: string, body: Record<string, unknown>, landed: (result: SlackResult) => string | undefined): Promise<SlackOutcome> {
    let response: Response;
    try {
      response = await this.fetcher(this.base + method, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      // The request may have reached Slack before the failure: a post can be ambiguous.
      return { kind: 'unknown', reason: e instanceof Error ? e.name : 'network' };
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      return { kind: 'later', afterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_WAIT_MS, reason: 'rate_limited' };
    }
    if (response.status >= 500) return { kind: 'unknown', reason: `http_${response.status}` };
    let result: SlackResult;
    try { result = await response.json(); } catch { return { kind: 'unknown', reason: 'invalid_response' }; }
    const ts = landed(result);
    if (ts !== undefined) return { kind: 'sent', ts };
    const error = typeof result.error === 'string' ? result.error : 'unknown_error';
    if (error === 'ratelimited') return { kind: 'later', afterMs: DEFAULT_WAIT_MS, reason: error };
    if (GONE.has(error)) return { kind: 'gone' };
    if (REFUSED.has(error)) return { kind: 'refused', reason: error };
    return { kind: 'later', afterMs: DEFAULT_WAIT_MS, reason: error };
  }
}
