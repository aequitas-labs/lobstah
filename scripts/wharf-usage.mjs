// What the wharf's Durable Objects cost per UTC day, from Cloudflare's
// GraphQL Analytics API: billed requests, active seconds, GB-s of duration,
// SQLite rows written and inbound WebSocket messages. Read-only.
//
//   node scripts/wharf-usage.mjs --account <cloudflare account id> [--since 2026-11-05] [--until 2026-11-12] [--json]
//
// The account comes from --account or CLOUDFLARE_ACCOUNT_ID, the token from
// CLOUDFLARE_API_TOKEN (Analytics read) or else `wrangler auth token`, run in
// services/wharf. The range defaults to the last seven days. Every Durable
// Object namespace on the account is summed per day; --namespace <id> keeps one.
//
// Requests are what the plan measured the wharf against: 11 Nov 2026, with a
// hosted glass open four hours, billed 32,060. On sockets the same day should
// bill under 1,000.
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUERY = `query ($account: String!, $since: Date!, $until: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      periodic: durableObjectsPeriodicGroups(limit: 1000, filter: { date_geq: $since, date_leq: $until }, orderBy: [date_ASC]) {
        dimensions { date namespaceId }
        sum { activeTime duration rowsWritten inboundWebsocketMsgCount }
      }
      invocations: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date_geq: $since, date_leq: $until }, orderBy: [date_ASC]) {
        dimensions { date namespaceId }
        sum { requests }
      }
    }
  }
}`;

/** A UTC day as YYYY-MM-DD. */
const day = (date) => date.toISOString().slice(0, 10);

/** Every day from `since` to `until`, inclusive. */
export function days(since, until) {
  const out = [];
  for (let d = new Date(`${since}T00:00:00Z`); day(d) <= until; d.setUTCDate(d.getUTCDate() + 1)) out.push(day(d));
  return out;
}

/**
 * One row per day of the range from the API's answer: a day with no
 * traffic is a row of zeros. activeTime comes in microseconds.
 */
export function usageRows(answer, since, until, namespace) {
  if (answer.errors?.length) throw new Error(answer.errors.map((e) => e.message).join('; '));
  const account = answer.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('no such account, or the token cannot read its analytics');
  const rows = new Map(days(since, until).map((date) => [date, { date, requests: 0, activeSeconds: 0, gbSeconds: 0, rowsWritten: 0, socketMessagesIn: 0 }]));
  const keep = (group) => !namespace || group.dimensions.namespaceId === namespace;
  for (const group of (account.invocations ?? []).filter(keep)) {
    const row = rows.get(group.dimensions.date);
    if (row) row.requests += group.sum.requests ?? 0;
  }
  for (const group of (account.periodic ?? []).filter(keep)) {
    const row = rows.get(group.dimensions.date);
    if (!row) continue;
    row.activeSeconds += (group.sum.activeTime ?? 0) / 1e6;
    row.gbSeconds += group.sum.duration ?? 0;
    row.rowsWritten += group.sum.rowsWritten ?? 0;
    row.socketMessagesIn += group.sum.inboundWebsocketMsgCount ?? 0;
  }
  return [...rows.values()];
}

/** The rows as an aligned table. */
export function renderTable(rows) {
  const head = ['day', 'requests', 'active s', 'GB-s', 'rows written', 'socket msgs in'];
  const body = rows.map((r) => [r.date, String(r.requests), r.activeSeconds.toFixed(1), r.gbSeconds.toFixed(2), String(r.rowsWritten), String(r.socketMessagesIn)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(head), ...body.map(line)].join('\n');
}

function argument(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The API token: CLOUDFLARE_API_TOKEN, or the one wrangler is logged in with. */
function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const wharf = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'services', 'wharf');
  const out = execFileSync('npx', ['wrangler', 'auth', 'token'], { cwd: wharf, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const found = out.match(/[A-Za-z0-9._-]{30,}/g)?.at(-1);
  if (!found) throw new Error('no Cloudflare token: set CLOUDFLARE_API_TOKEN or run `npx wrangler login` in services/wharf');
  return found;
}

export async function main(argv = process.argv.slice(2), fetcher = fetch) {
  const account = argument(argv, '--account') ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) throw new Error('give the Cloudflare account with --account <id> or CLOUDFLARE_ACCOUNT_ID');
  const until = argument(argv, '--until') ?? day(new Date());
  const since = argument(argv, '--since') ?? day(new Date(Date.parse(`${until}T00:00:00Z`) - 6 * 86_400_000));
  for (const d of [since, until]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`a day is YYYY-MM-DD, not ${d}`);
  if (since > until) throw new Error('--since comes after --until');
  const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { account, since, until } }),
  });
  if (!response.ok) throw new Error(`Cloudflare answered ${response.status}`);
  const rows = usageRows(await response.json(), since, until, argument(argv, '--namespace'));
  return argv.includes('--json') ? JSON.stringify(rows, null, 2) : renderTable(rows);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((out) => console.log(out), (error) => {
    console.error(`wharf-usage: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
