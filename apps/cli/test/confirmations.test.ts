import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureLayout, listGrants, rosterByAddress, signOnTrap } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
let env: NodeJS.ProcessEnv;
let trapName: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-confirm-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '');
  const worktree = path.join(home, 'worktree');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ sessionId: 'person-test', harness: 'codex', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  trapName = signed.ok.name!;
  env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX'))),
    LOBSTAH_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CODEX_HOME: path.join(home, 'no-codex'),
  };
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const run = (args: string[], input = '', overrides: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: home, env: { ...env, ...overrides }, input, encoding: 'utf8', timeout: 10_000 });

// A real terminal: wait for the prompt before typing, reproducing non-blocking
// stdin's EAGAIN rather than preloading an answer before the CLI starts.
const ttyAnswer = (args: string[]) =>
  spawnSync(
    'python3',
    [
      '-c',
      `
import errno, os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
sent = False
output = b''
deadline = time.monotonic() + 8
while time.monotonic() < deadline:
    if not select.select([fd], [], [], 0.1)[0]:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError as e:
        if e.errno == errno.EIO:
            break
        raise
    if not chunk:
        break
    output += chunk
    if b'[y/N]' in output and not sent:
        time.sleep(0.15)
        os.write(fd, b'y\\n')
        sent = True
else:
    os.kill(pid, signal.SIGKILL)
_, status = os.waitpid(pid, 0)
os.close(fd)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`,
      process.execPath,
      cli,
      ...args,
    ],
    { cwd: home, env, encoding: 'utf8', timeout: 12_000 },
  );

for (const command of ['grant', 'bypass', 'apply', 'remove'] as const) {
  describe(`${command} confirmation`, () => {
    function args(): string[] {
      if (command === 'grant') return ['grant', '--prefix', '--harness', 'codex', 'ume', 'push'];
      if (command === 'bypass') return ['trap', 'bypass', trapName, 'on'];
      if (command === 'remove') expect(run(['permissions', 'apply', '--yes']).status).toBe(0);
      return ['permissions', command];
    }
    function changed() {
      if (command === 'grant') expect(listGrants().grants).toMatchObject([{ command: 'ume push', match: 'prefix' }]);
      else if (command === 'bypass') expect(rosterByAddress(trapName)?.profile?.config?.bypass).toBe('true');
      else {
        const settings = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8'));
        if (command === 'apply') expect(settings.permissions?.allow?.length ?? 0).toBeGreaterThan(0);
        else expect(settings.permissions?.allow?.length ?? 0).toBe(0);
      }
    }

    it.skipIf(process.platform === 'win32')('waits on a TTY until y is typed', () => {
      const result = ttyAnswer(args());
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('[y/N]');
      changed();
    });
    it('accepts piped y', () => {
      const result = run(args(), 'y\n');
      expect(result.status, result.stderr + result.stdout).toBe(0);
      changed();
    });
    it('accepts --yes without stdin', () => {
      const result = run([...args(), '--yes']);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).not.toContain('[y/N]');
      changed();
    });
    it('fails clearly on EOF without a terminal', () => {
      const result = run(args());
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('no terminal to confirm; re-run with --yes');
    });
    it('--yes still refuses an agent session', () => {
      const result = run([...args(), '--yes'], '', { CODEX_THREAD_ID: 'agent' });
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('not an agent session');
    });
  });
}
