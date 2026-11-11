import { identifier, requireThat } from './protocol.js';

/** A link always names at least one grounds; no implicit all-grounds path exists. */
export function slackGrounds(value: unknown): string[] {
  requireThat(Array.isArray(value) && value.length > 0 && value.length <= 100, 400, 'Choose at least one grounds for Slack');
  const grounds = value.map(identifier);
  requireThat(new Set(grounds).size === grounds.length, 400, 'Choose each grounds once');
  return grounds.sort();
}

/** Read the structured grounds membership shared by OAuth, ingress and the glass. */
export async function linkedGrounds(env: Env, person: string): Promise<string[]> {
  const result = await env.AUTH_DB.prepare('SELECT grounds FROM slackLinkGround WHERE person=? ORDER BY grounds').bind(person).all<{ grounds: string }>();
  return result.results.map((row) => row.grounds);
}

/** Replace membership as part of the caller's D1 batch, never as a JSON link field. */
export function groundStatements(env: Env, person: string, grounds: string[]): D1PreparedStatement[] {
  return [env.AUTH_DB.prepare('DELETE FROM slackLinkGround WHERE person=?').bind(person),
    ...grounds.map((name) => env.AUTH_DB.prepare('INSERT INTO slackLinkGround VALUES (?,?)').bind(person, name))];
}
