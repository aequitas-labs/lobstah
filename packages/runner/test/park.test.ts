import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus,
  claimNext,
  enqueue,
  ensureLayout,
  laneDirs,
  readEvidence,
  readStatusLog,
  readWorktreeLock,
  sendMessage,
  unhandled,
} from '@lobstah/core';
import type { NormalizedEvent } from '@lobstah/core';
import { AsyncQueue } from '@lobstah/adapters';
import type { Adapter, AdapterRun, AdapterStartOpts } from '@lobstah/adapters';
import { worktreePath } from '@lobstah/worktree';
import { main } from '../src/run.js';
import type { RunnerDeps } from '../src/run.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A headless worker that reports `paused` parks: the runner ends the
 * session, stops what the harness started, and exits without a verb. The
 * dispatch stays active and keeps its worktree lock. The daemon's wake
 * resumes the session with what ended the wait.
 */

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-park-test-'));
  process.env.LOBSTAH_HOME = home;
  for (const k of ['LOBSTAH_RESUME', 'LOBSTAH_NUDGE', 'LOBSTAH_WAKE', 'LOBSTAH_ATTEMPTS']) delete process.env[k];
  ensureLayout();
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `[repos.r]\npath = ${JSON.stringify(path.join(home, 'repo'))}\ntrunk = "main"\n\n` +
      `[limits]\npushEarly = false\ndraftPr = false\ncheckpointOnStop = false\nexitGraceSecs = 2\n`,
  );
});
afterEach(() => {
  for (const k of ['LOBSTAH_RESUME', 'LOBSTAH_NUDGE', 'LOBSTAH_WAKE', 'LOBSTAH_ATTEMPTS']) delete process.env[k];
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const at = () => new Date().toISOString();
const verbs = (id: string) => readStatusLog(id, 'work').map((e) => e.verb);

/** A harness with one turn that closes its stream when the session ends. */
function harness(turn: (id: string) => void) {
  const calls = { end: 0, kill: 0, starts: [] as AdapterStartOpts[] };
  const adapter: Adapter = {
    name: 'claude',
    async start(s: AdapterStartOpts): Promise<AdapterRun> {
      calls.starts.push(s);
      const events = new AsyncQueue<NormalizedEvent>();
      let resolveDone!: (v: { sessionId?: string; error?: string }) => void;
      const done = new Promise<{ sessionId?: string; error?: string }>((r) => (resolveDone = r));
      const close = () => {
        events.close();
        resolveDone({ sessionId: 'sess' });
      };
      setTimeout(() => {
        events.push({ at: at(), type: 'session', data: { sessionId: 'sess' } });
        events.push({ at: at(), type: 'tool-start', data: { name: 'Bash' } });
        turn(s.id);
        events.push({ at: at(), type: 'turn-end', data: { subtype: 'success' } });
      }, 0);
      return {
        events,
        send: () => {},
        end: () => {
          calls.end++;
          close();
        },
        kill: () => {
          calls.kill++;
          close();
        },
        done,
      };
    },
  };
  return { adapter, calls };
}

function deps(adapter: Adapter, reaps: { n: number }): Partial<RunnerDeps> {
  return {
    loadAdapter: () => adapter,
    allocate: async (_repo, id) => {
      fs.mkdirSync(path.join(worktreePath(id), '.git'), { recursive: true });
      return worktreePath(id);
    },
    collectEvidence: async () => ({ branch: 'lobstah/x', commits: [] }),
    reap: async () => {
      reaps.n++;
      return 0;
    },
  };
}

describe('a paused headless dispatch parks without a harness', () => {
  it('pause, then wake on a message: the same session resumes with the message, and done finishes it', async () => {
    enqueue({ id: 'p1', repo: 'r', brief: 'do the thing' });
    expect(claimNext('work')).toBe('p1');
    const dir = path.join(laneDirs('work').active, 'p1');

    // First run: the worker pauses on a review.
    const first = harness((id) => appendStatus(id, 'work', 'paused', 'waiting on review', undefined, { waitingOn: 'review' }));
    const reaps = { n: 0 };
    await main(dir, 'work', deps(first.adapter, reaps));
    expect(verbs('p1')).toEqual(['working', 'paused']);
    expect(first.calls.end).toBe(1);
    expect(first.calls.kill).toBe(0);
    expect(reaps.n).toBe(1);
    // Still active, still holding its worktree, with the session to resume.
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(laneDirs('work').done, 'p1'))).toBe(false);
    expect(readWorktreeLock(worktreePath('p1'))?.id).toBe('p1');
    expect(readEvidence('p1', 'work').sessionId).toBe('sess');

    // The wake: the daemon resumes the session with the reason.
    sendMessage('p1', 'work', 'approved: merge when green');
    process.env.LOBSTAH_RESUME = 'sess';
    process.env.LOBSTAH_WAKE = '1 operator message(s) arrived';
    const second = harness((id) => appendStatus(id, 'work', 'done', 'finished'));
    await main(dir, 'work', deps(second.adapter, { n: 0 }));
    const start = second.calls.starts[0]!;
    expect(start.resumeSession).toBe('sess');
    expect(start.prompt).toContain('You were paused and this dispatch was parked. The wait ended: 1 operator message(s) arrived.');
    expect(start.prompt).toContain('approved: merge when green');
    expect(unhandled('p1', 'work')).toEqual([]);
    const log = readStatusLog('p1', 'work');
    expect(log.map((e) => e.verb)).toEqual(['working', 'paused', 'working', 'done']);
    expect(log[2]?.note).toContain('woke from pause: 1 operator message(s) arrived');
    expect(fs.existsSync(path.join(laneDirs('work').done, 'p1'))).toBe(true);
    expect(readWorktreeLock(worktreePath('p1'))).toBeUndefined();
  }, 15_000);
});
