import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serveGlass } from '../src/glass.js';
import { emptyFleet, ago } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { readPrDetails } from '../src/pr-details.js';

describe('on-demand PR descriptions', () => {
  it('reads rendered HTML with argv and refreshes signed URLs on every read', async () => {
    let generation = 0;
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ html_url: 'https://github.com/a/b/pull/7', title: 'A PR', body_html: `<img src="https://private-user-images.githubusercontent.com/img?jwt=${++generation}">`, user: { login: 'dana', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, head: { ref: 'topic' }, base: { ref: 'main' }, state: 'open' }), stderr: '' }));
    const first = await readPrDetails('pr:a/b#7', run as never);
    const second = await readPrDetails('pr:a/b#7', run as never);
    expect(first).toMatchObject({ title: 'A PR', headRefName: 'topic', author: { login: 'dana' } });
    expect(first?.bodyHtml).not.toBe(second?.bodyHtml);
    expect(run.mock.calls[0]).toEqual(['gh', ['api', 'repos/a/b/pulls/7', '-H', 'Accept: application/vnd.github.html+json'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }]);
  });
  it('rejects malformed identities without calling gh and handles missing access', async () => {
    const run = vi.fn(async () => { throw new Error('private'); });
    for (const key of ['pr:a/b#0', 'pr:a/b#7;echo secret', 'pr:a/b#7/extra', 'review:a/b#7']) expect(await readPrDetails(key, run as never)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(await readPrDetails('pr:a/b#7', run as never)).toBeUndefined();
  });
});

let home: string;
let server: Server | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'pr-details-')); process.env.LOBSTAH_HOME = home; });
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; delete process.env.LOBSTAH_HOME; removeTempDir(home); });
it('serves fresh descriptions only for a PR in this fleet and refuses writes', async () => {
  const fleet = emptyFleet();
  fleet.reviews = [{ key: 'review:a/b#7', repo: 'a/b', number: 7, title: 'A PR', url: 'https://github.com/a/b/pull/7', reviewUrl: 'https://github.com/a/b/pull/7', requestedAt: ago(60_000), state: 'drafted', stands: true, headSha: 'a', prHeadSha: 'a' }];
  const read = vi.fn(async key => ({ key, title: 'A PR', url: 'https://github.com/a/b/pull/7', bodyHtml: '<p>Fresh</p>' }));
  server = serveGlass(0, { snapshot: () => fleet, prDetails: read });
  if (!server.listening) await new Promise<void>(resolve => server!.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/data/pr/';
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + encodeURIComponent('pr:a/b#7'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ bodyHtml: '<p>Fresh</p>' });
  }
  expect(read).toHaveBeenCalledTimes(2);
  expect((await fetch(base + encodeURIComponent('pr:private/other#1'))).status).toBe(404);
  expect((await fetch(base + encodeURIComponent('pr:a/b#7'), { method: 'POST' })).status).toBe(405);
  expect(read).toHaveBeenCalledTimes(2);
});
