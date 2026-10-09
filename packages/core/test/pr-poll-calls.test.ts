import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addWatch, ensureLayout, ghPrViewDirect, parsePrRef, preparePrWatchBatch } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawnSync: vi.fn() }));
let home: string;
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

it('measures legacy open-PR transport calls versus the batched transport for 40 watches at 45 seconds', () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pr-call-count-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  vi.useFakeTimers();
  const start = Date.now();
  const run = vi.mocked(spawnSync);
  run.mockImplementation((_cmd, args) => ({
    status: 0,
    stdout:
      (args as string[])[0] === 'pr'
        ? JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: 'head', statusCheckRollup: [] })
        : JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
    stderr: '',
    pid: 1,
    output: [],
    signal: null,
  }));
  for (let tick = 0; tick < 80; tick++) for (let n = 1; n <= 40; n++) ghPrViewDirect(parsePrRef(`pr:acme/web#${n}`)!);
  expect(run).toHaveBeenCalledTimes(6400); // 3200 observations x (view + threads)
  run.mockClear();
  for (let n = 1; n <= 40; n++) addWatch(`pr:acme/web#${n}`, `lobstah watch check-pr 'pr:acme/web#${n}' --cursor {cursor}`);
  run.mockImplementation((_cmd, _args, opts) => {
    const { query } = JSON.parse(String(opts!.input));
    const repository: Record<string, unknown> = {};
    for (const m of query.matchAll(/pr(\d+):pullRequest/g))
      repository[`pr${m[1]}`] = {
        number: Number(m[1]),
        state: 'OPEN',
        isDraft: false,
        headRefOid: 'head',
        reviews: { nodes: [] },
        reviewThreads: { nodes: [] },
      };
    return {
      status: 0,
      stdout: JSON.stringify({ data: { repository, rateLimit: { cost: 1 } } }),
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    };
  });
  for (let tick = 0; tick < 80; tick++) {
    vi.setSystemTime(start + tick * 45_000);
    preparePrWatchBatch(45);
  }
  expect(run).toHaveBeenCalledTimes(80); // one repository batch per cycle, zero detail calls
});
