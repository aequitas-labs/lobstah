import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, listNotices, readTrap } from '@lobstah/core';
import { detectHarness, harnessFromSessionId } from '../src/harness-detect.js';

// Real ids from this machine (see the comment in harness-detect.ts).
const CODEX_ID = '01a0ceb8-b9bd-7d42-927c-c52a334b8e2d'; // UUIDv7
const CLAUDE_ID = '19a4f6e4-1341-492c-86a2-0d9261f5c632'; // UUIDv4
const BOTH = { CODEX_HOME: '/x', CLAUDE_CODE_SESSION_ID: 'y' };

describe('detectHarness', () => {
  it('only CODEX* in the environment → codex', () => {
    expect(detectHarness({ sessionId: CLAUDE_ID, env: { CODEX_HOME: '/x', PATH: '/bin' } })).toEqual({ harness: 'codex', source: 'env' });
  });

  it('only CLAUDE* in the environment → claude', () => {
    expect(detectHarness({ sessionId: CODEX_ID, env: { CLAUDECODE: '1' } })).toEqual({ harness: 'claude', source: 'env' });
  });

  it('both in the environment with a v7 id → codex', () => {
    expect(detectHarness({ sessionId: CODEX_ID, env: BOTH })).toEqual({ harness: 'codex', source: 'session-id' });
  });

  it('both in the environment with a v4 id → claude', () => {
    expect(detectHarness({ sessionId: CLAUDE_ID, env: BOTH })).toEqual({ harness: 'claude', source: 'session-id' });
  });

  it('both in the environment with an unparseable id → undecidable, with the reason', () => {
    const r = detectHarness({ sessionId: 's-helm', env: BOTH });
    expect(r.harness).toBeUndefined();
    expect(r.reason).toMatch(/both CLAUDE\* and CODEX\* are set.*neither a UUIDv7.*nor a UUIDv4/);
    // a UUID of another version is no better than garbage
    expect(detectHarness({ sessionId: '01a0ceb8-b9bd-1d42-927c-c52a334b8e2d', env: BOTH }).harness).toBeUndefined();
  });

  it('neither in the environment falls back to the id, else undecidable', () => {
    expect(detectHarness({ sessionId: CODEX_ID, env: {} })).toEqual({ harness: 'codex', source: 'session-id' });
    expect(detectHarness({ sessionId: 'abc', env: {} }).harness).toBeUndefined();
  });

  it('an explicit flag beats everything', () => {
    expect(detectHarness({ flag: 'claude', prior: 'codex', sessionId: CODEX_ID, env: { CODEX_HOME: '/x' } })).toEqual({
      harness: 'claude',
      source: 'flag',
    });
    expect(detectHarness({ flag: 'gemini', env: {} }).reason).toContain('--harness must be claude or codex');
  });

  it('the prior registration beats the environment on a re-soak', () => {
    expect(detectHarness({ prior: 'codex', sessionId: CLAUDE_ID, env: { CLAUDECODE: '1' } })).toEqual({ harness: 'codex', source: 'prior' });
  });

  it('reads the version nibble, not the order of anything', () => {
    expect(harnessFromSessionId(CODEX_ID)).toBe('codex');
    expect(harnessFromSessionId(CLAUDE_ID)).toBe('claude');
    expect(harnessFromSessionId(undefined)).toBeUndefined();
  });
});

// End to end: soak from a linked worktree of a throwaway repo.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let tmp: string;
let home: string;
let wt: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-harness-'));
  home = path.join(tmp, 'home');
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  wt = path.join(tmp, 'wt');
  git('worktree', 'add', '-q', wt, '-b', 'trap');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

/** Run soak in the worktree with exactly the given harness env (the runner's own is stripped). */
function soak(env: Record<string, string>, ...args: string[]) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return spawnSync(process.execPath, [cli, 'soak', ...args], {
    cwd: wt,
    encoding: 'utf8',
    env: { ...base, ...env, LOBSTAH_HOME: home },
    timeout: 10_000,
  });
}
const trap = () => readTrap(fs.readFileSync(path.join(wt, '.lobstah-trap'), 'utf8').match(/"trapId":\s*"([^"]+)"/)![1]!)!;

describe('soak — the harness is inferred', () => {
  it('a Codex session launched from inside Claude Code registers codex, and the notice says so', () => {
    const res = soak(BOTH, '--session', CODEX_ID);
    expect(res.status, res.stdout).toBe(0);
    expect(res.stdout).toContain('harness: codex (from the session id format)');
    expect(trap().harness).toBe('codex');
    expect(listNotices(10).find((n) => n.kind === 'trap-signed-on')?.text).toContain('(codex, ');
  });

  it('the same with a v4 id registers claude', () => {
    expect(soak(BOTH, '--session', CLAUDE_ID).status).toBe(0);
    expect(trap().harness).toBe('claude');
  });

  it('undecidable refuses with a usage error asking for --harness, instead of defaulting to claude', () => {
    const res = soak(BOTH, '--session', 's-not-a-uuid');
    expect(res.status).toBe(2);
    expect(res.stdout + res.stderr).toContain('Pass --harness claude|codex');
    expect(fs.existsSync(path.join(wt, '.lobstah-trap'))).toBe(false);
  });

  it('a re-soak keeps the registered harness; a differing --harness wins, updates it, and says so', () => {
    expect(soak({ CODEX_HOME: '/x' }, '--session', CLAUDE_ID).status).toBe(0);
    expect(trap().harness).toBe('codex');
    const again = soak({ CLAUDECODE: '1' }); // same session, from the anchor file
    expect(again.stdout).toContain('harness: codex (as signed on)');
    const flipped = soak({}, '--harness', 'claude');
    expect(flipped.stdout).toContain('harnessChanged: codex → claude (registration updated)');
    expect(trap().harness).toBe('claude');
  });
});
