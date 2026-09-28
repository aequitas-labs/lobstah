import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addWatch, appendStatus, ensureLayout, laneDirs, listNotices, listWatches, readWatch, releaseHeldWatches, signOnTrap } from '@lobstah/core';
import type { Descriptor } from '@lobstah/core';
import { watchLoop } from '../src/loops/watch.js';
import type { ReportNotification } from '../src/loops/report.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-watchloop-'));
  process.env.LOBSTAH_HOME = dir;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

function eventCheck(events: Array<{ seq: number; summary: string }>, cursor: string): string {
  const script = path.join(dir, `check-${cursor}.cjs`);
  fs.writeFileSync(
    script,
    `const cursor = process.argv[2];
if (cursor === '0') console.log(JSON.stringify({ cursor: ${JSON.stringify(cursor)}, events: ${JSON.stringify(events)} }));
else console.log(JSON.stringify({ cursor }));
`,
  );
  return `node "${script}" {cursor}`;
}

function makeOwnerDispatch(id: string, repo = 'myrepo'): void {
  const activeDir = path.join(laneDirs('work').active, id);
  fs.mkdirSync(activeDir, { recursive: true });
  const d: Descriptor = { id, repo, brief: 'original brief' };
  fs.writeFileSync(path.join(activeDir, 'descriptor.json'), JSON.stringify(d));
}

function queuedDescriptors(): Descriptor[] {
  return fs
    .readdirSync(laneDirs('work').queue)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(laneDirs('work').queue, f), 'utf8')) as Descriptor);
}

describe('watchLoop', () => {
  it('dispatch-owned events fork one continuation of the owning chain', async () => {
    const owner = '11111111-1111-1111-1111-111111111111';
    makeOwnerDispatch(owner);
    appendStatus(owner, 'work', 'paused', 'awaiting review');
    addWatch('ume:abc', eventCheck([{ seq: 1, summary: 'feedback batch' }], '1'), { owner: `dispatch:${owner}` });

    await watchLoop(45, () => {});
    const queued = queuedDescriptors();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.followUp).toBe(owner);
    expect(queued[0]!.repo).toBe('myrepo');
    expect(queued[0]!.brief).toContain('feedback batch');
    expect(readWatch('ume:abc')!.lastFollowUpId).toBe(queued[0]!.id);
  });

  it('holds further continuations while one is in flight', async () => {
    const owner = '22222222-2222-2222-2222-222222222222';
    makeOwnerDispatch(owner);
    const w = addWatch('ume:def', eventCheck([{ seq: 1, summary: 'round 1' }], '1'), { owner: `dispatch:${owner}` });

    await watchLoop(45, () => {});
    const first = queuedDescriptors();
    expect(first).toHaveLength(1);

    // More events arrive while the continuation is queued (non-terminal).
    fs.appendFileSync(
      path.join(dir, 'watches', 'ume-def.events'),
      `${JSON.stringify({ seq: 2, summary: 'round 2', at: new Date().toISOString() })}\n`,
    );
    // Force the watch due again with a quiet check.
    addWatch(w.key, 'echo {}', { owner: `dispatch:${owner}` });
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(1); // still just the first

    // Continuation finishes → next sweep forks the buffered round from it.
    const contId = first[0]!.id;
    appendStatus(contId, 'work', 'done', 'round 1 handled');
    await watchLoop(45, () => {});
    const after = queuedDescriptors();
    expect(after).toHaveLength(2);
    const second = after.find((d) => d.id !== contId && d.followUp !== undefined && d.brief.includes('round 2'));
    expect(second?.followUp).toBe(contId); // forks the LATEST session in the chain
  });

  it('man-owned events fire the notify hook and never enqueue anything', async () => {
    addWatch('ume:plan', eventCheck([{ seq: 1, summary: 'verdict: approved' }], '1'));
    const pings: ReportNotification[] = [];
    await watchLoop(45, () => {}, (n) => pings.push(n));
    expect(queuedDescriptors()).toHaveLength(0);
    expect(pings).toHaveLength(1);
    expect(pings[0]!.verb).toBe('watch');
    expect(pings[0]!.note).toBe('verdict: approved');
    expect(listWatches()).toHaveLength(1); // stays standing for man wait to consume
  });

  it('addresses the continuation to the live trap claiming the chain', async () => {
    const owner = '44444444-4444-4444-4444-444444444444';
    makeOwnerDispatch(owner);
    appendStatus(owner, 'work', 'paused', 'awaiting review');
    const worktree = path.join(process.env.LOBSTAH_HOME!, 'wt-live');
    fs.mkdirSync(worktree, { recursive: true });
    const res = signOnTrap({ sessionId: 'sess-1', harness: 'claude', worktree, cwd: worktree, ttlMs: 1800_000 });
    const trapId = 'ok' in res ? res.ok.trapId : '';
    fs.writeFileSync(
      path.join(laneDirs('work').active, owner, 'claim.json'),
      JSON.stringify({ by: `wt:${trapId}`, sessionId: 'sess-1', harness: 'claude', worktree, at: new Date().toISOString() }),
    );
    addWatch('ume:live', eventCheck([{ seq: 1, summary: 'round' }], '1'), { owner: `dispatch:${owner}` });

    await watchLoop(45, () => {});
    const queued = queuedDescriptors();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.for).toBe(`wt:${trapId}`);
    expect(queued[0]!.followUp).toBe(owner);
  });

  it('forks headless when the claiming trap is no longer signed on', async () => {
    const owner = '55555555-5555-5555-5555-555555555555';
    makeOwnerDispatch(owner);
    appendStatus(owner, 'work', 'paused', 'awaiting review');
    fs.writeFileSync(
      path.join(laneDirs('work').active, owner, 'claim.json'),
      JSON.stringify({ by: 'wt:deadbeef', sessionId: 'gone', harness: 'claude', worktree: '/wt', at: new Date().toISOString() }),
    );
    addWatch('ume:ghosted', eventCheck([{ seq: 1, summary: 'round' }], '1'), { owner: `dispatch:${owner}` });

    await watchLoop(45, () => {});
    const queued = queuedDescriptors();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.for).toBeUndefined();
  });

  it('drops a dispatch-owned watch whose owner is gone', async () => {
    addWatch('ume:orphan', eventCheck([{ seq: 1, summary: 'x' }], '1'), {
      owner: 'dispatch:33333333-3333-3333-3333-333333333333',
    });
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(0);
    expect(listWatches()).toHaveLength(0);
  });

  it('forks at most [watch].maxForksPerCycle continuations per cycle and holds the rest until released', async () => {
    const keys: string[] = [];
    for (let n = 1; n <= 5; n++) {
      const owner = `3333333${n}-3333-3333-3333-333333333333`;
      makeOwnerDispatch(owner);
      appendStatus(owner, 'work', 'done', 'shipped');
      const key = `ci:${n}`;
      keys.push(key);
      addWatch(key, eventCheck([{ seq: 1, summary: `check failed ${n}` }], `c${n}`), { owner: `dispatch:${owner}` });
    }
    const logs: string[] = [];
    await watchLoop(45, (m) => logs.push(m));
    expect(queuedDescriptors()).toHaveLength(3);
    const held = listWatches().filter((w) => w.heldAt).map((w) => w.key).sort();
    expect(held).toHaveLength(2);
    expect(logs.some((l) => l.includes('fork cap 3 reached'))).toBe(true);
    const notices = listNotices(50).filter((n) => n.kind === 'watch-held');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain(held[0]!);

    // Held watches stay held across cycles: nothing more forks, no second notice.
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(3);
    expect(listNotices(50).filter((n) => n.kind === 'watch-held')).toHaveLength(1);

    // Release lets them fork on the next cycle.
    expect(releaseHeldWatches().sort()).toEqual(held);
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(5);
    expect(listWatches().filter((w) => w.heldAt)).toEqual([]);
  });

  it('reads the fork cap from [watch].maxForksPerCycle', async () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), '[watch]\nmaxForksPerCycle = 1\n');
    for (let n = 1; n <= 3; n++) {
      const owner = `4444444${n}-4444-4444-4444-444444444444`;
      makeOwnerDispatch(owner);
      addWatch(`ci:${n}`, eventCheck([{ seq: 1, summary: `fail ${n}` }], `d${n}`), { owner: `dispatch:${owner}` });
    }
    await watchLoop(45, () => {});
    expect(queuedDescriptors()).toHaveLength(1);
    expect(listWatches().filter((w) => w.heldAt)).toHaveLength(2);
  });
});

describe('watchLoop failure logging', () => {
  it("logs the check's own reason with the watch key and exit code, then backs off", async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\necho 'GraphQL: Resource not accessible by integration (repository.pullRequest.statusCheckRollup)' >&2\nexit 1\n`,
    );
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    addWatch('pr:owner/repo#12', `PATH="${bin}:$PATH" gh pr view 12 --repo owner/repo --json statusCheckRollup`);
    const lines: string[] = [];
    await watchLoop(45, (m) => lines.push(m));
    expect(lines).toEqual([
      'pr:owner/repo#12 check failed: Resource not accessible by integration (repository.pullRequest.statusCheckRollup) (exit 1) — grant the GitHub App `Checks: read` (or use a token with the `repo` scope); see docs/github.md',
    ]);
    // Backed off: the next cycle, one cadence later, does not re-run the check.
    const w = readWatch('pr:owner/repo#12')!;
    w.lastCheckedAt = new Date(Date.now() - 50_000).toISOString();
    fs.writeFileSync(path.join(dir, 'watches', 'pr-owner-repo-12.json'), JSON.stringify(w));
    await watchLoop(45, (m) => lines.push(m));
    expect(lines).toHaveLength(1);
  });
});
