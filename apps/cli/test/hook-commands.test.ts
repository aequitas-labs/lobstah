import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, ensureLayout, readBeat, readTrap, sendTrapMessage, signOnTrap, takeHelm } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * `lobstah hook <event>` runs what the older hook command runs, for a helm, a
 * trap, and a session with neither role; the older commands stay as aliases.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const HELM = 'helm-session';
const NOBODY = 'no-role-session';
let home: string;

/** The CLI as a hook runs it: hook JSON on stdin, no harness session env. */
const hook = (args: string[], input: Record<string, unknown>) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    encoding: 'utf8',
    env: { ...env, LOBSTAH_HOME: home },
    input: JSON.stringify({ cwd: home, ...input }),
    timeout: 20_000,
  });
};

/** A signed-on trap for `session`; `harness` picks its park mode (codex parks in the hook). */
function trap(session: string, harness: 'claude' | 'codex' = 'codex'): string {
  const worktree = path.join(home, `wt-${session}`);
  fs.mkdirSync(worktree, { recursive: true });
  const signed = signOnTrap({ sessionId: session, harness, repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  return signed.ok.trapId;
}

const PAIRS = {
  'session-start': [['hook', 'session-start'], ['man', 'brief']],
  stop: [['hook', 'stop'], ['man', 'haul']],
  'post-tool-use': [['hook', 'post-tool-use'], ['soak', 'beat']],
  'session-end': [['hook', 'session-end'], ['stow', '--quiet']],
} as const;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-hook-cmds-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\narmGraceSecs = 0.2\n');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('lobstah hook session-start (alias: man brief)', () => {
  for (const [label, args] of [['hook session-start', PAIRS['session-start'][0]], ['man brief', PAIRS['session-start'][1]]] as const) {
    it(`${label}: the helm, a trap, and a session with neither role each get their brief`, () => {
      takeHelm({ sessionId: HELM, grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
      trap('trap-session');
      const brief = (session: string) => {
        const res = hook([...args], { session_id: session, hook_event_name: 'SessionStart' });
        expect(res.status, res.stderr).toBe(0);
        return (JSON.parse(res.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      };
      expect(brief(HELM)).toContain('you hold the helm for grounds "fleet"');
      expect(brief('trap-session')).toContain('this session mans trap');
      // A session with no role still learns its id: Codex has no other source.
      expect(brief(NOBODY)).toContain(`lobstah: session id ${NOBODY}.`);
    });
  }
});

describe('lobstah hook stop (alias: man haul)', () => {
  for (const [label, args] of [['hook stop', PAIRS.stop[0]], ['man haul', PAIRS.stop[1]]] as const) {
    it(`${label}: a trap wakes on its message; the helm is asked to arm; neither role is inert`, () => {
      const trapId = trap('trap-session');
      sendTrapMessage(trapId, 'check the fleet', 'helm');
      const woke = hook([...args, '--timeout', '1'], { session_id: 'trap-session', hook_event_name: 'Stop' });
      expect(woke.status, woke.stderr).toBe(0);
      expect(JSON.parse(woke.stdout)).toMatchObject({ decision: 'block' });
      expect(woke.stdout).toContain('check the fleet');

      takeHelm({ sessionId: HELM, grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
      enqueue({ id: '99999999-9999-4999-8999-999999999999', repo: 'web', brief: 'b' });
      const helm = hook([...args], { session_id: HELM, hook_event_name: 'Stop' });
      expect(helm.stdout).toContain(`lobstah man wait --session ${HELM}`);

      const none = hook([...args], { session_id: NOBODY, hook_event_name: 'Stop' });
      expect(none.status).toBe(0);
      expect(none.stdout).toBe('');
    });
  }
});

describe('lobstah hook post-tool-use (alias: soak beat)', () => {
  for (const [label, args] of [['hook post-tool-use', PAIRS['post-tool-use'][0]], ['soak beat', PAIRS['post-tool-use'][1]]] as const) {
    it(`${label}: beats a trap; inert for neither role`, () => {
      const trapId = trap('trap-session');
      expect(readBeat(trapId)).toBeUndefined();
      const res = hook([...args], {
        session_id: 'trap-session',
        cwd: readTrap(trapId)!.worktree,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(res.status).toBe(0);
      expect(readBeat(trapId)?.sessionId).toBe('trap-session');
      const none = hook([...args], { session_id: NOBODY, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
      expect(none.status).toBe(0);
      expect(none.stdout).toBe('');
    });
  }
});

describe('lobstah hook session-end (alias: stow --quiet)', () => {
  for (const [label, args] of [['hook session-end', PAIRS['session-end'][0]], ['stow --quiet', PAIRS['session-end'][1]]] as const) {
    it(`${label}: stows a trap; inert for neither role`, () => {
      const trapId = trap('trap-session');
      const res = hook([...args], { session_id: 'trap-session', hook_event_name: 'SessionEnd' });
      expect(res.status, res.stderr).toBe(0);
      expect(readTrap(trapId)).toBeUndefined();
      const none = hook([...args], { session_id: NOBODY, hook_event_name: 'SessionEnd' });
      expect(none.status).toBe(0);
      expect(none.stdout).toBe('');
    });
  }
});

describe('lobstah hook', () => {
  it('bare prints its card; an unknown event is a usage error', () => {
    const bare = hook(['hook'], {});
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain('session-start|stop|post-tool-use|session-end');
    const unknown = hook(['hook', 'pre-compact'], {});
    expect(unknown.status).toBe(2);
  });

  it("both plugins' hooks.json run the new commands", () => {
    for (const plugin of ['claude-code', 'codex']) {
      const file = fileURLToPath(new URL(`../../../plugins/${plugin}/hooks/hooks.json`, import.meta.url));
      const hooks = (JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }).hooks;
      expect(Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, groups[0]!.hooks[0]!.command]))).toEqual({
        SessionStart: 'lobstah hook session-start',
        PostToolUse: 'lobstah hook post-tool-use',
        Stop: 'lobstah hook stop',
        SessionEnd: 'lobstah hook session-end',
      });
    }
  });
});
