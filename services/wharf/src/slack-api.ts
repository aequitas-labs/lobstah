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

/** Posts and edits one bot's messages. Holds the token for one call; never stores or logs it. */
export class SlackApi {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  post(channel: string, message: SlackMessage): Promise<SlackOutcome> { return this.call('chat.postMessage', { channel, ...message }); }
  update(channel: string, ts: string, message: SlackMessage): Promise<SlackOutcome> { return this.call('chat.update', { channel, ts, ...message }); }
  private async call(method: string, body: Record<string, unknown>): Promise<SlackOutcome> {
    let response: Response;
    try {
      response = await this.fetcher(API + method, {
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
    let result: { ok?: boolean; ts?: unknown; error?: unknown };
    try { result = await response.json(); } catch { return { kind: 'unknown', reason: 'invalid_response' }; }
    if (result.ok && typeof result.ts === 'string') return { kind: 'sent', ts: result.ts };
    const error = typeof result.error === 'string' ? result.error : 'unknown_error';
    if (error === 'ratelimited') return { kind: 'later', afterMs: DEFAULT_WAIT_MS, reason: error };
    if (GONE.has(error)) return { kind: 'gone' };
    if (REFUSED.has(error)) return { kind: 'refused', reason: error };
    return { kind: 'later', afterMs: DEFAULT_WAIT_MS, reason: error };
  }
}
