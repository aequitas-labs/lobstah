import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, enqueue, ensureLayout, readActivity } from '@lobstah/core';
import { AsyncQueue } from '@lobstah/adapters';
import type { AdapterRun } from '@lobstah/adapters';
import type { NormalizedEvent } from '@lobstah/core';
import { drive } from '../src/drive.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-runner-activity-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const TOKEN = 'sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe';

/** A stubbed event stream: the given events, then a done report and a turn end. */
function stubRun(id: string, evs: NormalizedEvent[]): AdapterRun {
  const events = new AsyncQueue<NormalizedEvent>();
  let resolveDone!: (v: { sessionId?: string }) => void;
  const done = new Promise<{ sessionId?: string }>((r) => (resolveDone = r));
  const finish = () => {
    events.close();
    resolveDone({ sessionId: 's' });
  };
  setTimeout(() => {
    for (const e of evs) events.push(e);
    appendStatus(id, 'work', 'done', 'ok');
    events.push({ at: new Date().toISOString(), type: 'turn-end', data: {} });
  }, 0);
  return { events, send: () => {}, end: finish, kill: finish, done };
}

const at = () => new Date().toISOString();

describe('drive derives activity from the event stream', () => {
  it('writes the latest activity, relative to the worktree, with no secret', async () => {
    enqueue({ id: 'a1', repo: 'r', brief: 'x' });
    claimNext('work');
    const wt = path.join(home, 'wt');
    const run = stubRun('a1', [
      { at: at(), type: 'thinking', data: {} },
      { at: at(), type: 'tool-start', data: { name: 'Bash', target: TOKEN } },
      { at: at(), type: 'tool-start', data: { name: 'Edit', target: path.join(wt, 'src', 'a.ts') } },
    ]);
    await drive(run, { id: 'a1', lane: 'work', cwd: wt, pollMs: 10 });
    const a = readActivity('a1', 'work')!;
    expect(a).toMatchObject({ kind: 'tool', summary: 'Edit src/a.ts' });
    expect(fs.readFileSync(path.join(home, 'state', 'a1.activity'), 'utf8')).not.toContain(TOKEN);
  });

  it('throttles: same-kind events inside the window are held, then flushed at the end', async () => {
    enqueue({ id: 'a2', repo: 'r', brief: 'x' });
    claimNext('work');
    const run = stubRun('a2', [
      { at: at(), type: 'tool-start', data: { name: 'Read' } },
      { at: at(), type: 'tool-start', data: { name: 'Grep' } },
      { at: at(), type: 'tool-start', data: { name: 'Glob' } },
    ]);
    await drive(run, { id: 'a2', lane: 'work', pollMs: 10, activityThrottleMs: 60_000 });
    // First write, then the held record flushed when the run ends.
    expect(readActivity('a2', 'work')?.summary).toBe('Glob');
  });
});
