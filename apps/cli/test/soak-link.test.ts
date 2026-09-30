import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, listTraps, signOnTrap } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { focusRegistration } from '../src/focus.js';

// End to end: soak --link through the built CLI, in each session's own
// environment. The CLI decides whether a session link fits the surface the
// session runs in; the glass and focus ignore a stored link that does not.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SESSION = '11111111-2222-4333-8444-555555555555';
const VSCODE_LINK = `vscode://anthropic.claude-code/open?session=${SESSION}`;

/** Each test spawns git and the CLI several times. */
const processTest = (name: string, run: () => void) => it(name, run, 90_000);

let tmp: string;
let home: string;
let primary: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-soaklink-')));
  home = path.join(tmp, 'home');
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  const origin = path.join(tmp, 'origin.git');
  primary = path.join(tmp, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, primary], { stdio: 'ignore' });
  fs.writeFileSync(path.join(primary, 'f.txt'), 'one\n');
  git(primary, 'add', '.');
  git(primary, 'commit', '-q', '-m', 'init');
  git(primary, 'push', '-q', 'origin', 'HEAD:main');
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${primary}'\ntrunk = 'main'\n`);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

/** soak in an environment like a real session's: its own entrypoint, app, and terminal. */
function soak(surface: Record<string, string>, ...args: string[]) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX') && k !== 'TERM_PROGRAM' && k !== '__CFBundleIdentifier'),
  );
  return spawnSync(process.execPath, [cli, 'soak', '--session', SESSION, '--harness', 'claude', ...args], {
    cwd: primary,
    encoding: 'utf8',
    env: { ...base, LOBSTAH_HOME: home, ...surface },
    input: '',
    timeout: 60_000,
  });
}

const DESKTOP_TERMINAL = { CLAUDE_CODE_ENTRYPOINT: 'cli', TERM_PROGRAM: 'claude-desktop', __CFBundleIdentifier: 'com.anthropic.claudefordesktop' };
const VSCODE_EXTENSION = { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' };

describe('soak --link fits the session surface', () => {
  processTest("a vscode:// link from a CLI in the Claude desktop app's terminal is ignored, and soak says why", () => {
    const res = soak(DESKTOP_TERMINAL, '--link', VSCODE_LINK);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("link: ignored — a vscode:// link needs the VS Code extension; this session's entrypoint is cli");
    const [reg] = listTraps();
    expect(reg?.link).toBeUndefined();
    expect(reg?.window).toMatchObject({ entrypoint: 'cli', termProgram: 'claude-desktop', bundleId: 'com.anthropic.claudefordesktop' });
  });

  processTest('a vscode:// link inside the VS Code extension is kept, and a re-soak from a terminal drops it', () => {
    const res = soak(VSCODE_EXTENSION, '--link', VSCODE_LINK);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toContain('link: ignored');
    expect(listTraps()[0]?.link).toBe(VSCODE_LINK);
    // The same session re-soaks from a terminal: the kept link no longer fits.
    expect(soak(DESKTOP_TERMINAL).status).toBe(0);
    expect(listTraps()[0]?.link).toBeUndefined();
  });
});

describe('a stored link that contradicts its window', () => {
  // A registration from before this check, written directly: a CLI in the
  // Claude desktop app's terminal panel with a vscode:// link.
  const badRegistration = () => {
    const worktree = path.join(tmp, 'wt');
    fs.mkdirSync(worktree, { recursive: true });
    const signed = signOnTrap({ worktree, cwd: worktree, sessionId: SESSION, harness: 'claude', ttlMs: 60_000, window: { bundleId: 'com.anthropic.claudefordesktop', termProgram: 'claude-desktop', tty: 'ttys004' } });
    if ('held' in signed) throw new Error('unexpected hold');
    const file = path.join(home, 'soaking', `${signed.ok.trapId}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...signed.ok, link: VSCODE_LINK }));
    return { ...signed.ok, link: VSCODE_LINK };
  };

  it('is not shown in the glass', () => {
    const reg = badRegistration();
    expect(buildGlassSnapshot().traps.find((t) => t.trapId === reg.trapId)?.link).toBeUndefined();
  });

  it('is skipped by focus, which activates the Claude desktop app instead', async () => {
    const reg = badRegistration();
    const calls: Array<[string, string[]]> = [];
    const result = await focusRegistration(reg, { platform: 'darwin', run: async (file, args) => void calls.push([file, args]) });
    expect(calls).toEqual([['open', ['-b', 'com.anthropic.claudefordesktop']]]);
    expect(result).toMatchObject({ focused: true, step: 'app' });
  });
});
