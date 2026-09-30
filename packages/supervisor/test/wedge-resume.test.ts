import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { claimNext, DEFAULT_LIMITS, DEFAULT_SOAK, enqueue, ensureLayout, eventsPath, laneDirs, statusPath } from '@lobstah/core';
import { reconcileOne, tick } from '../src/daemon.js';
import type { ActiveState } from '../src/daemon.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// After the machine sleeps, every worker's last event is old because the
// machine slept, not because the worker wedged. Wedge handling waits one
// wedge threshold after the daemon resumes.
let home: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-wedge-resume-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  vi.useRealTimers();
  for (const c of children.splice(0)) c.kill('SIGKILL');
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const cfg = { repos: {}, harness: {}, limits: { ...DEFAULT_LIMITS, wedgeThresholdSecs: 600 }, soak: DEFAULT_SOAK };

/** A working dispatch whose runner is alive and whose last event is two hours old. */
function silent(id: string): ActiveState {
  enqueue({ id, repo: 'r', brief: 'do the thing' });
  claimNext('work');
  const old = new Date(Date.now() - 2 * 3600_000);
  fs.writeFileSync(statusPath(id, 'work'), `${JSON.stringify({ at: old.toISOString(), verb: 'working' })}\n`);
  fs.writeFileSync(eventsPath(id, 'work'), '');
  fs.utimesSync(eventsPath(id, 'work'), old, old);
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true });
  children.push(c);
  const runner = { pid: c.pid!, startedAt: new Date(old.getTime() - 60_000).toISOString(), attempts: 1 };
  const dir = path.join(laneDirs('work').active, id);
  fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify(runner));
  return { id, lane: 'work', dir, runner };
}

describe('wedge handling after the machine resumes', () => {
  it('in the resume grace a silent worker is left alone; outside it, it is forked as wedged', () => {
    const st = silent('aaaaaaaa-0000-4000-8000-00000000000a');
    const spawned: string[] = [];
    reconcileOne(st, cfg, () => {}, (s) => void spawned.push(s.id), true);
    expect(spawned).toEqual([]);
    const logs: string[] = [];
    reconcileOne(st, cfg, (m) => logs.push(m), (s) => void spawned.push(s.id), false);
    expect(spawned).toEqual([st.id]);
    expect(logs.join('\n')).toContain('wedged (no activity)');
  });

  it('a tick delayed past the wedge threshold starts the grace; after it, wedge handling resumes', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[repos.r]\npath = "/nonexistent"\ntrunk = "main"\n[limits]\nwedgeThresholdSecs = 600\n');
    const st = silent('bbbbbbbb-0000-4000-8000-00000000000b');
    const spawned: string[] = [];
    let now = Date.now() - 2 * 3600_000;
    const hooks = { now: () => now, spawnRunner: ((s: ActiveState) => void spawned.push(s.id)) as never, freeBytes: () => 1e15 };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    tick(() => {}, hooks);
    // The machine sleeps for two hours; the next tick is the first after wake.
    now += 2 * 3600_000;
    vi.setSystemTime(now);
    tick(() => {}, hooks);
    expect(spawned).toEqual([]);
    // The daemon keeps ticking each minute; the worker stays silent.
    for (let i = 0; i < 9; i++) {
      now += 60_000;
      vi.setSystemTime(now);
      tick(() => {}, hooks);
    }
    expect(spawned).toEqual([]);
    // One wedge threshold after the resume, it is wedged.
    now += 61_000;
    vi.setSystemTime(now);
    tick(() => {}, hooks);
    expect(spawned).toEqual([st.id]);
  });
});
