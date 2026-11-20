import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addWatch, ensureLayout, enqueue, appendStatus, noticesDir, parsePrRef, prEvidence, readPr, readWatch, takeHelm, upsertPr } from '@lobstah/core';
import type { GhPrView } from '@lobstah/core';
import { addPrWatch, syncPrWatches } from '../src/pr-watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-large-state-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = ${JSON.stringify(home.replace(/\\/g, '/'))}\ntrunk = "main"\n`);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});
function run(...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX') && k !== 'LOBSTAH_GROUNDS'));
  const started = Date.now();
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: home, env: { ...env, LOBSTAH_HOME: home }, encoding: 'utf8', timeout: 60_000 });
  return { ...r, ms: Date.now() - started };
}

it('man wait --peek on a large state answers without running due watches; a consuming wait runs them', () => {
  // Months of notices, as a busy fleet leaves them.
  fs.mkdirSync(noticesDir(), { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 4000; i++) {
    const seq = `${String(now - i * 60_000).padStart(15, '0')}-1-${String(i).padStart(8, '0')}`;
    fs.writeFileSync(path.join(noticesDir(), `${seq}.json`), JSON.stringify({ seq, kind: 'dispatch-progress', at: new Date(now - i * 60_000).toISOString(), text: `notice ${i}` }));
  }
  // Due watches whose checks are slow: a peek that ran them would take at least 20 × 0.5 s.
  const marker = (i: number) => path.join(home, `ran-${i}`);
  // A node one-liner, not sleep/touch: watch checks run under cmd.exe on Windows and sh elsewhere.
  const slowCheck = `setTimeout(()=>{require('fs').writeFileSync(process.argv[1],'');console.log(JSON.stringify({cursor:'1'}))},500)`;
  for (let i = 0; i < 20; i++) addWatch(`slow-${i}`, `"${process.execPath}" -e "${slowCheck}" "${marker(i)}"`, { everySecs: 30 });
  // Every watch last checked long ago, so all are due.
  const watches = path.join(home, 'watches');
  for (const name of fs.readdirSync(watches).filter((f) => f.endsWith('.json'))) {
    const file = path.join(watches, name);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), lastCheckedAt: '2000-01-01T00:00:00.000Z' }));
  }
  takeHelm({ sessionId: 'test-helm', grounds: { name: 'home', repos: ['web'] }, ttlMs: 60_000 });

  const peek = run('man', 'wait', '--peek', '--session', 'test-helm');
  expect(peek.status, peek.stderr).toBe(0);
  expect(peek.ms).toBeLessThan(8000);
  expect([...Array(20).keys()].filter((i) => fs.existsSync(marker(i)))).toEqual([]);

  run('man', 'wait', '--timeout', '1', '--session', 'test-helm');
  expect([...Array(20).keys()].filter((i) => fs.existsSync(marker(i)))).toHaveLength(20);
}, 90_000);

const ref = (n: number) => parsePrRef(`pr:acme/web#${n}`)!;
const view = (n: number): GhPrView => ({
  state: 'OPEN', isDraft: false, headRefOid: `sha${n}`, baseRefName: 'main', headRefName: `b${n}`,
  mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', reviews: [], statusCheckRollup: [],
});
const snapshot = (n: number, state = 'OPEN') => ({
  ...view(n), state, number: n, url: ref(n).url,
  reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] },
});

it('runs shipped PR checks in this process, so a wait spawns no lobstah per due PR', () => {
  const id = '12345678-1234-4123-8123-123456789012';
  enqueue({ id, repo: 'web', brief: 'work' }, 'work');
  appendStatus(id, 'work', 'done', 'opened the PR');
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const entry = process.argv[1];
  // The registered check names a lobstah that does not exist: a spawned check would fail.
  process.argv[1] = path.join(home, 'no-such-lobstah.js');
  try {
    fs.writeFileSync(process.argv[1], '');
    for (const n of [1, 2]) {
      upsertPr(prEvidence(ref(n), view(n), new Date(now - 60_000).toISOString()));
      addPrWatch(ref(n), n === 1 ? { forId: id } : {});
    }
  } finally {
    fs.rmSync(process.argv[1], { force: true });
    process.argv[1] = entry;
  }
  const run = vi.fn((query: string) => {
    const repository: Record<string, unknown> = { pr1: snapshot(1, 'MERGED'), pr2: snapshot(2) };
    for (const m of query.matchAll(/(link\d+):pullRequests/g)) repository[m[1]!] = { nodes: [] };
    return { status: 0, stdout: JSON.stringify({ data: { repository } }) };
  });
  syncPrWatches(now, { run });
  expect(run).toHaveBeenCalledTimes(1);
  expect(readWatch(ref(2).key)?.lastError).toBeUndefined();
  expect(readPr(ref(1).key)).toMatchObject({ state: 'MERGED', observedAt: new Date(now).toISOString() });
  expect(readPr(ref(2).key)?.observedAt).toBe(new Date(now).toISOString());
});
