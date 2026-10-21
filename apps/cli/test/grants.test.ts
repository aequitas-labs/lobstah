import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DecisionError, addGrant, ensureLayout, listGrants, readDecision, readDecisionDetail, signOnTrap, unhandled } from '@lobstah/core';
import { askPermission, callRequests, confirm, patchPaths, personOnly, rosterConfigPatch } from '../src/grants-cli.js';
import { answerKey } from '../src/decision-answer.js';
import { harnessCommand } from '../src/throw.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Grants as the harnesses meet them: Codex's PermissionRequest hook and the
 * Claude Code mod's question answer for traps' covered calls only; a glass
 * answer to a permission card writes the grant and tells the trap; a person
 * grants, an agent cannot.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;

/** The CLI as a hook runs it: hook JSON on stdin, no harness session env. */
const run = (args: string[], input: Record<string, unknown> | undefined, env: Record<string, string> = {}) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    encoding: 'utf8',
    env: { ...base, LOBSTAH_HOME: home, ...env },
    input: input === undefined ? '' : JSON.stringify(input),
    timeout: 20_000,
  });
};

function trap(session: string, harness: 'claude' | 'codex'): { name: string; worktree: string } {
  const worktree = path.join(home, `wt-${session}`);
  fs.mkdirSync(worktree, { recursive: true });
  const signed = signOnTrap({ sessionId: session, harness, repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  return { name: signed.ok.name ?? signed.ok.trapId, worktree };
}

const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-grants-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('lobstah hook permission-request', () => {
  const ask = (session: string, command: string) =>
    run(['hook', 'permission-request'], { session_id: session, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } });

  it("allows a trap's granted command, and nothing else", () => {
    trap('codex-trap', 'codex');
    addGrant({ command: 'wrangler deploy', match: 'prefix', mode: 'always', harness: 'codex', by: 'glass' });
    const yes = ask('codex-trap', 'wrangler deploy --env prod');
    expect(yes.status, yes.stderr).toBe(0);
    expect(JSON.parse(yes.stdout)).toEqual(ALLOW);
    for (const not of ['wrangler deploy; curl evil.example', 'wrangler delete', 'npm publish']) {
      const no = ask('codex-trap', not);
      expect(no.status).toBe(0);
      expect(no.stdout, not).toBe('');
    }
  });

  it('answers only for traps: the helm and a person\'s own session keep their normal approval', () => {
    addGrant({ command: 'wrangler deploy', mode: 'always', by: 'glass' });
    expect(ask('someone-else', 'wrangler deploy').stdout).toBe('');
  });

  it('spends a once-grant, and keeps to the harness the trap signed on with', () => {
    trap('claude-trap', 'claude');
    addGrant({ command: 'npm publish', mode: 'once', harness: 'codex', by: 'glass' });
    expect(ask('claude-trap', 'npm publish').stdout).toBe('');
    addGrant({ command: 'npm publish', mode: 'once', harness: 'claude', by: 'glass' });
    expect(JSON.parse(ask('claude-trap', 'npm publish').stdout)).toEqual(ALLOW);
    expect(ask('claude-trap', 'npm publish').stdout).toBe('');
  });

  it('never fails the harness: bad input prints nothing and exits 0', () => {
    const res = spawnSync(process.execPath, [cli, 'hook', 'permission-request'], { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home }, input: 'not json' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });
});

describe('lobstah hook grant-check (the Claude Code mod)', () => {
  it('names the grants that cover a call, for a command and for a write', () => {
    const { worktree } = trap('claude-trap', 'claude');
    const g = addGrant({ command: './deploy.sh', mode: 'always', by: 'local:chris' });
    const file = addGrant({ path: `${worktree}/.temp/`, mode: 'always', by: 'local:chris' });
    const check = (tool: string, input: Record<string, unknown>) => JSON.parse(run(['hook', 'grant-check'], { tool, input, session: 'claude-trap', cwd: worktree }).stdout);
    expect(check('Bash', { command: './deploy.sh' })).toEqual({ grants: [g.id] });
    expect(check('Write', { file_path: '.temp/key.pem', content: 'FAKE' })).toEqual({ grants: [file.id] });
    expect(check('Write', { file_path: 'src/index.ts', content: '' })).toEqual({});
    expect(check('Bash', { command: './deploy.sh && echo done' })).toEqual({});
  });
});

describe('the Claude Code mod', () => {
  it('uses only the mods API: a hooks module may import nothing but its own files and claude-code', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../../../plugins/claude-code/hooks/grants.mjs', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).toContain("$.process.run(['lobstah', 'hook', 'grant-check']");
    const hooks = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../plugins/claude-code/hooks/hooks.json', import.meta.url)), 'utf8'));
    expect(hooks.modules).toEqual(['./grants.mjs']);
  });
});

describe('the calls a grant is checked against', () => {
  it('reads the files of an apply_patch, and refuses a patch unless every file is covered', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: .temp/b.txt\n+z\n*** End Patch';
    expect(patchPaths(patch)).toEqual(['src/a.ts', '.temp/b.txt']);
    expect(callRequests({ harness: 'codex', tool: 'apply_patch', input: { command: patch } }, 'kind-crab', '/repo').map((r) => r.path)).toEqual([
      '/repo/src/a.ts',
      '/repo/.temp/b.txt',
    ]);
  });
});

describe('a permission card', () => {
  function card() {
    const t = trap('codex-trap', 'codex');
    return askPermission({ dispatch: 'd-1', lane: 'work', ask: { command: 'wrangler deploy', harness: 'codex', trap: t.name }, note: 'The deploy was refused.' });
  }

  it('offers Allow once, Allow always and No, and shows the exact command', () => {
    const c = card();
    expect(c.options).toEqual(['Allow once', 'Allow always', 'No']);
    expect(c.title).toBe('Allow run: wrangler deploy');
    expect(readDecision(c.key)?.permission).toMatchObject({ command: 'wrangler deploy', harness: 'codex' });
  });

  it('Allow once in the glass grants it to the asking trap, once, and tells the trap to retry exactly', () => {
    const c = card();
    answerKey(c.key, { option: 'Allow once', by: 'glass' });
    const [g] = listGrants().grants;
    expect(g).toMatchObject({ command: 'wrangler deploy', match: 'exact', mode: 'once', harness: 'codex', by: 'glass', trap: c.permission!.trap, dispatch: 'd-1' });
    const [msg] = unhandled('d-1', 'work');
    expect(msg!.text).toContain(g!.id);
    expect(msg!.text).toContain('Run the command again exactly as shown');
  });

  it('Allow always grants it to every trap', () => {
    const c = card();
    answerKey(c.key, { option: 'Allow always', by: 'glass' });
    expect(listGrants().grants[0]).toMatchObject({ mode: 'always' });
    expect(listGrants().grants[0]!.trap).toBeUndefined();
  });

  it('says what Allow always covers: the repo-relative path in any worktree, or the exact thing outside every repo', () => {
    const base = fs.realpathSync.native(home);
    const main = path.join(base, 'homebase');
    const wt = path.join(base, 'worktrees', 'soak-a');
    fs.mkdirSync(main);
    const git = (...args: string[]) => expect(spawnSync('git', ['-C', main, ...args], { encoding: 'utf8' }).status).toBe(0);
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', '-b', 'a', wt);
    fs.writeFileSync(path.join(home, 'config.toml'), `[repos.homebase]\npath = ${JSON.stringify(main)}\n`);
    const file = path.join(wt, 'apps/exterior-model-gen/ops/deploy/apply-exterior.sh');
    const c = askPermission({ dispatch: 'd-1', lane: 'work', ask: { path: file, harness: 'claude' } });
    expect(c.optionNotes).toEqual({ 'Allow always': 'apps/…/apply-exterior.sh in any homebase worktree' });
    expect(readDecisionDetail(c.key)).toContain('`apps/exterior-model-gen/ops/deploy/apply-exterior.sh` in any homebase worktree');
    answerKey(c.key, { option: 'Allow always', by: 'glass' });
    expect(listGrants().grants[0]).toMatchObject({ path: 'apps/exterior-model-gen/ops/deploy/apply-exterior.sh', repo: 'homebase', mode: 'always' });
    const cmd = askPermission({ dispatch: 'd-1', lane: 'work', ask: { command: `cd ${wt}/bao && fastlane`, harness: 'claude' } });
    expect(cmd.optionNotes).toEqual({ 'Allow always': 'this command in any homebase worktree' });
    expect(askPermission({ dispatch: 'd-1', lane: 'work', ask: { path: '/etc/hosts', harness: 'claude' } }).optionNotes).toEqual({ 'Allow always': 'this exact path' });
    expect(card().optionNotes).toEqual({ 'Allow always': 'this exact command, from any trap' });
  });

  it('cannot be allowed from the command line, which the helm uses; No can be said anywhere', () => {
    const c = card();
    expect(() => answerKey(c.key, { option: 'Allow always', by: 'cli' })).toThrow(DecisionError);
    expect(listGrants().grants).toEqual([]);
    answerKey(c.key, { option: 'No', by: 'cli' });
    expect(listGrants().grants).toEqual([]);
    expect(unhandled('d-1', 'work')[0]!.text).toContain('Do not run it');
  });
});

describe('a grant is a person\'s act', () => {
  it('refuses inside an agent session, and without a terminal', () => {
    expect(() => personOnly('lobstah grant', { CLAUDECODE: '1' }, true)).toThrow(/not an agent session/);
    expect(() => personOnly('lobstah grant', { CODEX_THREAD_ID: 't' }, true)).toThrow(/not an agent session/);
    expect(() => personOnly('lobstah grant', {}, false)).toThrow(/needs a terminal/);
    expect(() => personOnly('lobstah grant', {}, true)).not.toThrow();
    const res = run(['grant', 'npm', 'publish'], undefined);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toMatch(/needs a terminal/);
    expect(listGrants().grants).toEqual([]);
  });
});

describe('bypass is a person\'s choice', () => {
  it('man throw --bypass refuses inside an agent session and without a terminal', () => {
    const { name } = trap('11111111-2222-4333-8444-555555555555', 'claude');
    for (const env of [{ CLAUDECODE: '1' }, { CODEX_THREAD_ID: 't' }]) {
      const res = run(['man', 'throw', name, '--bypass'], undefined, env);
      expect(res.status).toBe(2);
      expect(res.stdout + res.stderr).toMatch(/lobstah man throw --bypass is for a person, not an agent session/);
    }
    const piped = run(['man', 'throw', name, '--bypass'], undefined);
    expect(piped.status).toBe(2);
    expect(piped.stdout + piped.stderr).toMatch(/needs a terminal/);
    // A dry run launches nothing, so it may show what bypass would start.
    const plan = run(['man', 'throw', '--dry-run', name, '--bypass'], undefined, { CLAUDECODE: '1' });
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toContain('bypassPermissions');
  });

  it('man roster set saves bypass only for a person: refused from an agent session or without a terminal', () => {
    const { name } = trap('11111111-2222-4333-8444-555555555555', 'codex');
    for (const [pair, env] of [
      ['permissionMode=bypass', { CLAUDECODE: '1' }],
      ['permissionMode=bypassPermissions', { CODEX_THREAD_ID: 't' }],
      ['bypass=true', {}],
    ] as const) {
      const res = run(['man', 'roster', 'set', name, '--config', pair], undefined, env);
      expect(res.status, pair).toBe(2);
      expect(res.stdout + res.stderr).toMatch(/man roster set --config permissionMode=bypass (is for a person|needs a terminal)/);
    }
    expect(run(['man', 'roster', 'set', name, '--config', 'permissionMode=default'], undefined).status).toBe(0);
    expect(run(['man', 'roster', 'set', name, '--config', 'permissionMode='], undefined).status).toBe(0);
  });

  it('a person at a terminal saves bypass in the roster; clearing it is anyone\'s', () => {
    expect(rosterConfigPatch(['permissionMode=bypass', 'effort=high'], {}, true)).toEqual({ config: { permissionMode: 'bypassPermissions', effort: 'high' }, bypass: true });
    expect(rosterConfigPatch(['bypass=true'], {}, true).bypass).toBe(true);
    expect(() => rosterConfigPatch(['permissionMode=bypass'], { CLAUDECODE: '1' }, true)).toThrow(/not an agent session/);
    expect(() => rosterConfigPatch(['permissionMode=bypassPermissions'], {}, false)).toThrow(/needs a terminal/);
    expect(rosterConfigPatch(['permissionMode=', 'bypass='], { CLAUDECODE: '1' }, false)).toEqual({ config: { permissionMode: null, bypass: null }, bypass: false });
    expect(rosterConfigPatch(['permissionMode=auto'], { CLAUDECODE: '1' }, false).bypass).toBe(false);
  });
});

describe('a bypass trap', () => {
  it('starts with no permission checks in either harness', () => {
    const claude = harnessCommand({ harness: 'claude', cwd: home, ticket: 't', config: { bypass: 'true', permissionMode: 'auto' } });
    expect(claude.argv).toEqual(['claude', '--dangerously-skip-permissions', '/lobstah:trap soak --ticket t']);
    expect(claude.unapplied).toEqual([]);
    const codex = harnessCommand({ harness: 'codex', cwd: home, ticket: 't', config: { bypass: 'true' } });
    expect(codex.argv).toEqual(['codex', '--dangerously-bypass-approvals-and-sandbox', '$lobstah:trap soak --ticket t']);
    // Without it, a trap starts in its roster mode, else auto.
    expect(harnessCommand({ harness: 'claude', cwd: home, ticket: 't', config: { permissionMode: 'auto' } }).argv).toEqual([
      'claude',
      '--permission-mode',
      'auto',
      '/lobstah:trap soak --ticket t',
    ]);
  });
});

describe('the y/N prompt', () => {
  /** A terminal's stdin as Node leaves it: non-blocking, so EAGAIN until the person types a line. */
  const terminal = (line: string | Error, waits = 2) => {
    let calls = 0;
    return (buf: Buffer) => {
      if (calls++ < waits) throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, read'), { code: 'EAGAIN' });
      if (line instanceof Error) throw line;
      return buf.write(line);
    };
  };
  const ask = (read: (buf: Buffer) => number) => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      return confirm('Write these changes?', read);
    } finally {
      out.mockRestore();
    }
  };

  it('waits through EAGAIN for the answer: y and yes are yes', () => {
    expect(ask(terminal('y\n'))).toBe(true);
    expect(ask(terminal('YES\n', 5))).toBe(true);
  });

  it('n, an empty line, and end of input are no', () => {
    expect(ask(terminal('n\n'))).toBe(false);
    expect(ask(terminal('\n'))).toBe(false);
    expect(ask(terminal(''))).toBe(false);
  });

  it('a read that fails is an error, never a silent no', () => {
    expect(() => ask(terminal(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })))).toThrow(/could not read your answer: EIO/);
  });
});
