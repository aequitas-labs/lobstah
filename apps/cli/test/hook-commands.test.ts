import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, ensureLayout, readBeat, readTrap, readHelm, sendTrapMessage, signOnTrap, takeHelm,
  noticeDispatchProgress, unseenNotices, expectReply, claimNext, appendStatus, laneDirs, statusPath, trapWorkingStop, baitBrief } from '@lobstah/core';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';
import { charter, FILE_REPORT_RULE, HELM_REMINDER } from '../src/charter.js';
import { attentionNow } from '@lobstah/supervisor';
import { DEFAULT_WAIT, IdleWait } from '@lobstah/core';

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
      expect(brief(HELM)).toContain('you hold the helm for grounds "home"');
      expect(brief('trap-session')).toContain('this session mans trap');
      // A session with no role still learns its id: Codex has no other source.
      expect(brief(NOBODY)).toContain(`lobstah: session id ${NOBODY}.`);
    });
  }
});

describe('lobstah hook user-prompt-submit', () => {
  it('resets only the prompted helm or trap session; other sessions stay inert', () => {
    takeHelm({ sessionId: HELM, grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000 });
    trap('prompted-trap');
    for (const session of [HELM, 'prompted-trap']) {
      for (let i = 0; i < 7; i++) new IdleWait(session, DEFAULT_WAIT, undefined, 0).timedOut(14_400_000);
    }
    for (const session of [HELM, 'prompted-trap']) {
      expect(new IdleWait(session, DEFAULT_WAIT).timeoutSecs).toBe(14400);
      expect(hook(['hook', 'user-prompt-submit'], { session_id: session }).status).toBe(0);
      expect(new IdleWait(session, DEFAULT_WAIT).timeoutSecs).toBe(900);
    }
    const before = fs.readdirSync(path.join(home, 'wait-backoff')).sort();
    expect(hook(['hook', 'user-prompt-submit'], { session_id: NOBODY }).status).toBe(0);
    expect(fs.readdirSync(path.join(home, 'wait-backoff')).sort()).toEqual(before);
  });
  for (const harness of ['claude', 'codex'] as const) {
    it(`${harness}: captures only observed fields on hooks for both registered roles`, () => {
      takeHelm({ sessionId: HELM, grounds: { name: 'fleet', repos: [] }, ttlMs: 60_000, identity: { harness } });
      const id = trap('trap-session', harness);
      for (const session of [HELM, 'trap-session']) {
        const r = hook(['hook', 'user-prompt-submit'], { session_id: session, hook_event_name: 'UserPromptSubmit', model: 'custom/local-model', permission_mode: 'plan', effort: 'high', prompt: 'do not save', env: { token: 'secret' } });
        expect(r.status, r.stderr).toBe(0);
      }
      expect(readHelm('fleet')).toMatchObject({ model: 'custom/local-model', config: { effort: null, permissionMode: 'plan' } });
      expect(readTrap(id)).toMatchObject({ model: 'custom/local-model', config: { effort: null, permissionMode: 'plan' } });
      expect(fs.readFileSync(path.join(home, 'session-workers', `${HELM}.json`), 'utf8')).not.toMatch(/do not save|secret|token|high/);
    });
  }
  for (const harness of ['claude', 'codex'] as const) {
    it(`${harness}: adds the card reminder each turn for the helm, but not traps or other sessions`, () => {
      takeHelm({ sessionId: HELM, grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000, identity: { harness } });
      trap('trap-session', harness);
      for (const prompt of ['First turn', 'Another turn']) {
        const res = hook(['hook', 'user-prompt-submit'], { session_id: HELM, hook_event_name: 'UserPromptSubmit', prompt });
        expect(res.status, res.stderr).toBe(0);
        const context = JSON.parse(res.stdout).hookSpecificOutput;
        expect(context.hookEventName).toBe('UserPromptSubmit');
        expect(context.additionalContext).toContain(HELM_REMINDER);
        expect(context.additionalContext.includes('First message of the day')).toBe(prompt === 'First turn');
        expect(context.prompt).toBeUndefined();
      }
      for (const session of ['trap-session', NOBODY]) {
        const res = hook(['hook', 'user-prompt-submit'], { session_id: session, hook_event_name: 'UserPromptSubmit', prompt: 'A question?' });
        expect(res.status, res.stderr).toBe(0);
        expect(res.stdout).toBe('');
      }
    });
  }

  it('tells the helm, in its charter Role and both man skills, to file its own pages with man file', () => {
    expect(charter({ name: 'fleet', repos: ['web'] }).split('Role:')[1]?.split('Fences:')[0]).toContain(FILE_REPORT_RULE);
    for (const plugin of ['claude-code', 'codex']) {
      const skill = fs.readFileSync(fileURLToPath(new URL(`../../../plugins/${plugin}/skills/man/SKILL.md`, import.meta.url)), 'utf8');
      expect(skill).toContain(FILE_REPORT_RULE);
      expect(skill.split('## Working set')[1]?.split('## Rules')[0]).toContain('lobstah man file <file.md> [--attach <img>] [--title <t>]');
    }
  });

  it('includes the same reminder in the helm charter Role section', () => {
    expect(charter({ name: 'fleet', repos: ['web'] }).split('Role:')[1]?.split('Fences:')[0]).toContain(HELM_REMINDER);
  });
});

describe('lobstah hook stop (alias: man haul)', () => {
  it('lists current pauses with note and age after delivery, scoped to the helm', () => {
    takeHelm({ sessionId: HELM, grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
    for (const [id, repo] of [['pause', 'web'], ['foreign', 'other']]) {
      enqueue({ id, repo, brief: 'b' }); claimNext('work');
      appendStatus(id, 'work', 'paused', `${id} note`, '2026-10-01T00:00:00Z', { waitingOn: 'external' });
    }
    attentionNow(true);
    const stopped = hook(['hook', 'stop'], { session_id: HELM });
    expect(stopped.status, stopped.stderr).toBe(0);
    const reason = JSON.parse(stopped.stdout).reason;
    expect(reason).toMatch(/paused pause · waiting on external for \S+ — pause note/);
    expect(reason).not.toContain('foreign note');
    expect(renderTend(buildTendReport())).toContain('pause note');
    appendStatus('pause', 'work', 'working', 'resumed');
    expect(hook(['hook', 'stop'], { session_id: HELM }).stdout).not.toContain('pause note');
  });

  it('keeps the human-wait rule in bait and both plugins, and pause triage in the charter', () => {
    const rule = 'Waiting on a human is `needs-decision` with the question or the thing to look at, never `paused`.';
    expect(baitBrief('job', { repo: 'web', brief: 'work' })).toContain(rule);
    for (const plugin of ['codex', 'claude-code']) {
      for (const skill of ['trap', 'man']) {
        expect(fs.readFileSync(fileURLToPath(new URL(`../../../plugins/${plugin}/skills/${skill}/SKILL.md`, import.meta.url)), 'utf8')).toContain(rule);
      }
    }
    expect(charter({ name: 'fleet', repos: ['web'] })).toContain('Read each pause and decide if the human needs to act.');
  });

  for (const harness of ['claude', 'codex'] as const) {
    it(`${harness}: working blocks once, then passes without an arm/park loop`, () => {
      const trapId = trap('working-session', harness);
      const id = '77777777-7777-4777-8777-777777777777';
      enqueue({ id, repo: 'web', brief: 'b' }); claimNext('work');
      fs.writeFileSync(path.join(laneDirs('work').active, id, 'claim.json'), JSON.stringify({ by: `wt:${trapId}`, sessionId: 'working-session', at: new Date().toISOString() }));
      const reg = readTrap(trapId)!;
      fs.writeFileSync(path.join(home, 'soaking', `${trapId}.json`), JSON.stringify({ ...reg, claimed: id }));
      appendStatus(id, 'work', 'working', 'still executing', undefined, undefined, true);
      const first = hook(['hook', 'stop'], { session_id: 'working-session' });
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout).reason).toContain('about to go idle');
      expect(JSON.parse(first.stdout).reason).toContain('waiting on an external await, report paused and name it');
      expect(hook(['hook', 'stop'], { session_id: 'working-session' }).stdout).toBe('');
      expect(hook(['hook', 'stop'], { session_id: 'working-session', stop_hook_active: true }).stdout).toBe('');
    });

  }
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

it('idle-working attention appears in helm Stop, tend and status with the full note', () => {
  const trapId = trap('idle-session');
  const id = '77777777-7777-4777-8777-777777777777';
  enqueue({ id, repo: 'web', brief: 'b' }); claimNext('work');
  fs.writeFileSync(path.join(laneDirs('work').active, id, 'claim.json'), JSON.stringify({ by: `wt:${trapId}`, sessionId: 'idle-session', at: new Date().toISOString() }));
  const reg = { ...readTrap(trapId)!, claimed: id };
  fs.writeFileSync(path.join(home, 'soaking', `${trapId}.json`), JSON.stringify(reg));
  const note = 'Holding both PRs until Chris says the design is settled; full final question?';
  appendStatus(id, 'work', 'working', note, undefined, undefined, true);
  trapWorkingStop(reg, true, Date.now() - 120_000);
  takeHelm({ sessionId: HELM, grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
  noticeDispatchProgress(); unseenNotices(true);
  const stopped = hook(['hook', 'stop'], { session_id: HELM });
  expect(stopped.status, stopped.stderr).toBe(0);
  expect(stopped.stdout).toContain('idle-while-working');
  expect(stopped.stdout).toContain(note);
  expect(renderTend(buildTendReport())).toContain(note);
  expect(buildTendReport().attention.find((a) => a.id === id)?.verb).toBe('idle-while-working');
  const status = hook(['status', id], {});
  expect(status.status, status.stderr).toBe(0);
  expect(status.stdout).toContain('attention: idle-while-working');
  expect(status.stdout).toContain(note);
  expect(hook(['status'], {}).stdout).toContain('idle-while-working');
  expect(hook(['status', `wt:${trapId}`], {}).stdout).toContain('idle-while-working');
});

it('Stop lists overdue queues and stalls beside send expectations even after the wake was consumed', () => {
  takeHelm({ sessionId: HELM, grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
  const queued = '99999999-9999-4999-8999-999999999999';
  enqueue({ id: queued, repo: 'web', brief: 'b', for: 'wt:absent', queuedAt: new Date(Date.now() - 200_000).toISOString() });
  const silent = '88888888-8888-4888-8888-888888888888';
  enqueue({ id: silent, repo: 'web', brief: 'b' });
  // The addressed queue remains sticky; claim this fixture explicitly.
  expect(claimNext('work', (d) => d.id !== silent)).toBe(silent);
  fs.writeFileSync(statusPath(silent, 'work'), JSON.stringify({ at: new Date(Date.now() - 1300_000).toISOString(), verb: 'working', note: 'old note' }) + '\n');
  expectReply({ dispatchId: queued, lane: 'work', from: HELM, text: 'do it' });
  noticeDispatchProgress(); unseenNotices(true);
  const stopped = hook(['hook', 'stop'], { session_id: HELM, hook_event_name: 'Stop' });
  expect(stopped.status, stopped.stderr).toBe(0);
  expect(stopped.stdout).toContain('queued-too-long');
  expect(stopped.stdout).toContain('not signed on');
  expect(stopped.stdout).toContain('stalled');
  expect(stopped.stdout).toContain('old note');
  expect(stopped.stdout).toContain('sent ·');
  // Grounds scoping: neither unrelated queued work nor its reason leaks.
  fs.rmSync(path.join(laneDirs('work').queue, `${queued}.json`));
  appendStatus(silent, 'work', 'paused', 'wait');
  enqueue({ id: 'foreign', repo: 'other', brief: 'b', queuedAt: new Date(Date.now() - 200_000).toISOString() });
  expect(hook(['hook', 'stop'], { session_id: HELM }).stdout).not.toContain('queued-too-long');
});

it('man wait wakes without polling status when the daemon posts an overdue queue notice', () => {
  const id = '77777777-7777-4777-8777-777777777777';
  enqueue({ id, repo: 'web', brief: 'b', for: 'wt:absent', queuedAt: new Date(Date.now() - 200_000).toISOString() });
  noticeDispatchProgress();
  const woke = hook(['man', 'wait', '--timeout', '1'], {});
  expect(woke.status, woke.stderr).toBe(0);
  expect(woke.stdout).toContain('queued-too-long');
  expect(woke.stdout).toContain('not signed on');
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
    expect(bare.stdout).toContain('session-start|user-prompt-submit|stop|post-tool-use|session-end|permission-request|grant-check');
    const unknown = hook(['hook', 'pre-compact'], {});
    expect(unknown.status).toBe(2);
  });

  it("both plugins' hooks.json run the new commands", () => {
    for (const plugin of ['claude-code', 'codex']) {
      const file = fileURLToPath(new URL(`../../../plugins/${plugin}/hooks/hooks.json`, import.meta.url));
      const hooks = (JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }).hooks;
      expect(Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, groups[0]!.hooks[0]!.command]))).toEqual({
        SessionStart: 'lobstah hook session-start',
        UserPromptSubmit: 'lobstah hook user-prompt-submit',
        PostToolUse: 'lobstah hook post-tool-use',
        PermissionRequest: 'lobstah hook permission-request',
        Stop: 'lobstah hook stop',
        SessionEnd: 'lobstah hook session-end',
      });
    }
  });
});
