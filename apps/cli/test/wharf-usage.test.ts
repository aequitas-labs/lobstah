import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error a plain .mjs script, without types
import { main, renderTable, usageRows } from '../../../scripts/wharf-usage.mjs';

/**
 * scripts/wharf-usage.mjs: what the wharf costs per UTC day, one row per
 * day of the range, summed over Durable Object namespaces.
 */

const ns = (namespaceId: string, date: string) => ({ date, namespaceId });
const answer = {
  data: { viewer: { accounts: [{
    invocations: [
      { dimensions: ns('wharf', '2026-11-11'), sum: { requests: 32060 } },
      { dimensions: ns('other', '2026-11-11'), sum: { requests: 40 } },
      { dimensions: ns('wharf', '2026-11-12'), sum: { requests: 2259 } },
    ],
    periodic: [
      { dimensions: ns('wharf', '2026-11-11'), sum: { activeTime: 1_836_389_222, duration: 235.0578, rowsWritten: 95705, inboundWebsocketMsgCount: 12 } },
      { dimensions: ns('wharf', '2026-11-12'), sum: { activeTime: 165_504_337, duration: 21.1846, rowsWritten: 7024, inboundWebsocketMsgCount: 0 } },
    ],
  }] } },
};

beforeEach(() => { process.env.CLOUDFLARE_API_TOKEN = 'test-token'; });
afterEach(() => { delete process.env.CLOUDFLARE_API_TOKEN; delete process.env.CLOUDFLARE_ACCOUNT_ID; });

it('prints one row per day of the range, a quiet day as zeros, with requests, active seconds, GB-s, rows written and socket messages', async () => {
  const fetcher = vi.fn(async () => Response.json(answer));
  const out = await main(['--account', 'acct', '--since', '2026-11-10', '--until', '2026-11-12', '--json'], fetcher);
  expect(JSON.parse(out)).toEqual([
    { date: '2026-11-10', requests: 0, activeSeconds: 0, gbSeconds: 0, rowsWritten: 0, socketMessagesIn: 0 },
    { date: '2026-11-11', requests: 32100, activeSeconds: 1836.389222, gbSeconds: 235.0578, rowsWritten: 95705, socketMessagesIn: 12 },
    { date: '2026-11-12', requests: 2259, activeSeconds: 165.504337, gbSeconds: 21.1846, rowsWritten: 7024, socketMessagesIn: 0 },
  ]);
  // One read-only query, for that account and range, with the token in the header only.
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  expect(JSON.parse(String(init.body)).variables).toEqual({ account: 'acct', since: '2026-11-10', until: '2026-11-12' });
});

it('keeps one namespace when asked, and prints a table by default', async () => {
  expect(usageRows(answer, '2026-11-11', '2026-11-11', 'other')[0]).toMatchObject({ requests: 40, gbSeconds: 0 });
  const table = await main(['--account', 'acct', '--since', '2026-11-11', '--until', '2026-11-11'], async () => Response.json(answer));
  expect(table.split('\n')).toHaveLength(2);
  expect(table).toMatch(/^day\s+requests\s+active s\s+GB-s\s+rows written\s+socket msgs in\n2026-11-11\s+32100\s+1836\.4\s+235\.06\s+95705\s+12$/);
  expect(renderTable([])).toMatch(/^day/);
});

it('defaults to the seven days ending today, and refuses a bad range, a missing account or an API error', async () => {
  const fetcher = vi.fn(async () => Response.json(answer));
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
  const rows = JSON.parse(await main(['--until', '2026-11-12', '--json'], fetcher));
  expect(rows.map((r: { date: string }) => r.date)).toEqual(['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  await expect(main(['--since', '2026-11-12', '--until', '2026-11-01'], fetcher)).rejects.toThrow('after');
  await expect(main(['--since', '11/12'], fetcher)).rejects.toThrow('YYYY-MM-DD');
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  await expect(main([], fetcher)).rejects.toThrow('--account');
  await expect(main(['--account', 'acct'], async () => Response.json({ errors: [{ message: 'not authorized' }] }))).rejects.toThrow('not authorized');
  await expect(main(['--account', 'acct'], async () => new Response('', { status: 403 }))).rejects.toThrow('403');
});
