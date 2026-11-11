import type { WharfHumanRequest } from '../../../packages/core/src/backend-model.js';
import type { SlackMessageIn } from './slack-ingress.js';

/** A DM is either assigned to a bound grounds or held for an explicit choice. */
export type SlackGroundRoute = { message: SlackMessageIn; grounds: string } | { question: { threadTs: string; grounds: string[] } } | { ignored: string };
type PendingGroundRequest = { person: string; channel: string; ts: string; text: string; grounds: string | null; choice_ts: string | null; prompted: number; at: number };

/** An ambiguous DM remains outside the work queue until its person selects a grounds. */
export const slackRoutingSchema: string = `CREATE TABLE IF NOT EXISTS slack_ground_requests (
  person TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL,
  grounds TEXT, choice_ts TEXT, prompted INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY(person,channel,ts));`;

/** Resolve a message using only the live link's grounds; ambiguity never wakes a helm. */
export function routeSlackMessage(sql: SqlStorage, person: string, message: SlackMessageIn, grounds: string[], now: number): SlackGroundRoute {
  sql.exec('DELETE FROM slack_ground_requests WHERE at<?', now - 86_400_000);
  if (!grounds.length) return { ignored: 'no linked grounds' };
  const top = message.threadTs ?? message.ts;
  const pending = sql.exec<PendingGroundRequest>('SELECT * FROM slack_ground_requests WHERE person=? AND channel=? AND ts=?', person, message.channel, top).toArray()[0];
  if (pending?.choice_ts === message.ts) return { ignored: 'grounds choice already recorded' };
  const request = sql.exec<{ data: string }>('SELECT data FROM human_requests WHERE id=?', `slack-${message.channel}-${top.replace('.', '-')}`).toArray()[0];
  if (request) {
    const recorded = JSON.parse(request.data) as WharfHumanRequest;
    return recorded.grounds && grounds.includes(recorded.grounds) ? { message, grounds: recorded.grounds } : { ignored: 'request grounds is not linked' };
  }
  if (message.threadTs) {
    if (!pending) return { ignored: 'not an open request thread' };
    const chosen = message.text.trim();
    if (!grounds.includes(chosen)) return { question: { threadTs: top, grounds } };
    sql.exec('UPDATE slack_ground_requests SET grounds=?,choice_ts=? WHERE person=? AND channel=? AND ts=?', chosen, message.ts, person, message.channel, top);
    return { grounds: chosen, message: { ...message, ts: top, text: pending.text, threadTs: undefined } };
  }
  if (grounds.length === 1) return { message, grounds: grounds[0]! };
  if (!pending) sql.exec('INSERT INTO slack_ground_requests(person,channel,ts,text,at) VALUES (?,?,?,?,?)', person, message.channel, top, message.text, now);
  return pending?.prompted ? { ignored: 'waiting for grounds choice' } : { question: { threadTs: top, grounds } };
}
