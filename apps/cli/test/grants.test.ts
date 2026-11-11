import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DecisionError,
  addGrant,
  claimBait,
  commandGrantScope,
  enqueue,
  ensureLayout,
  listGrants,
  revokeGrant,
  readDecision,
  readDecisionDetail,
  readStatusLog,
  appendStatus,
  askDecision,
  settlePermissionCards,
  stowTrap,
  signOnTrap,
  standingDecisions,
  takeHelm,
  trapBySession,
  unhandled,
} from '@lobstah/core';
import { askPermission, callRequests, confirm, patchPaths, personOnly, rosterConfigPatch } from '../src/grants-cli.js';
import { answerKey } from '../src/decision-answer.js';
import { buildGlassSnapshot } from '../src/glass.js';
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

describe('a permission card follows its tool call', () => {
  const session = 'waiting-trap';
  const command = 'pnpm exec check-release';
  /** Register and claim a dispatch as the harness does before asking. */
  function claim(harness: 'claude' | 'codex' = 'claude'): void {
    trap(session, harness);
    enqueue({ id: 'waiting-work', repo: 'web', brief: 'Check the release' });
    claimBait(trapBySession(session)!);
  }
  /** A harness request with a stable call id, shared by its completion hooks. */
  function request(id: string, harness: 'claude' | 'codex' = 'claude'): void {
    const result = run(['hook', 'permission-request'], {
      session_id: session, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: id,
      ...(harness === 'codex' ? { turn_id: 'first-turn' } : {}), tool_input: { command },
    });
    expect(result.status, result.stderr).toBe(0);
  }

  it.each(['claude', 'codex'] as const)('retires a completed %s call and refuses a late local answer', harness => {
    claim(harness);
    request('finished-call', harness);
    const [card] = standingDecisions();
    expect(card!.permission?.call?.id).toBe('finished-call');
    const result = run(['hook', 'post-tool-use'], {
      session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'finished-call', tool_input: { command },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(standingDecisions()).toEqual([]);
    expect(() => answerKey(card!.key, { option: 'Allow once', by: 'glass' })).toThrow(/no decision/);
    expect(listGrants().grants).toEqual([]);
  });

  it.each(['PostToolUseFailure', 'PermissionDenied', 'PostToolBatch'])('retires a failed, denied or timed-out call through %s', event => {
    claim();
    request('ended-call');
    const result = run(['hook', event === 'PermissionDenied' ? 'permission-denied' : 'post-tool-use'], {
      session_id: session, hook_event_name: event, tool_name: 'Bash', tool_use_id: 'ended-call', tool_input: { command },
      tool_calls: [{ tool_use_id: 'ended-call', tool_name: 'Bash', tool_input: { command }, is_error: true }],
      error: 'Permission prompt timed out',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(standingDecisions()).toEqual([]);
    expect(listGrants().grants).toEqual([]);
  });

  it('keeps parallel calls separate even when their command is identical', () => {
    claim();
    request('first-call');
    request('second-call');
    expect(standingDecisions()).toHaveLength(2);
    settlePermissionCards({ session_id: session, hook_event_name: 'PostToolUse', tool_use_id: 'first-call' });
    expect(standingDecisions().map(card => card.permission?.call?.id)).toEqual(['second-call']);
  });

  it.each(['Stop', 'SessionEnd', 'UserPromptSubmit'])('retires automatic cards on %s while preserving an explicit proposal', event => {
    claim();
    request('old-call');
    const proposal = askPermission({ dispatch: 'waiting-work', lane: 'work', ask: { command: 'npm publish', harness: 'claude' } });
    settlePermissionCards({ session_id: session, hook_event_name: event });
    expect(standingDecisions().map(card => card.key)).toEqual([proposal.key]);
  });

  it('retires a superseded Codex turn', () => {
    claim('codex');
    request('old-call', 'codex');
    const result = run(['hook', 'pre-tool-use'], {
      session_id: session, hook_event_name: 'PreToolUse', turn_id: 'next-turn', tool_use_id: 'next-call', tool_name: 'Read', tool_input: { file_path: 'readme' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(standingDecisions()).toEqual([]);
  });

  it('retires legacy cards by command when no call identity was saved', () => {
    claim();
    askDecision({ title: 'Legacy permission', options: ['Allow once', 'No'], dispatch: 'waiting-work', lane: 'work', askedBy: 'worker',
      permission: { session, tool: 'Bash', command, harness: 'claude' }, maxBytes: 1_000_000 });
    settlePermissionCards({ session_id: session, hook_event_name: 'PostToolBatch', tool_calls: [{ tool_use_id: 'legacy-call', tool_name: 'Bash', tool_input: { command } }] });
    expect(standingDecisions()).toEqual([]);
  });

  it.each(['working', 'paused', 'done', 'failed'])('refuses a stale answer after the dispatch reports %s before another snapshot is read', verb => {
    claim();
    request('old-call');
    const [card] = standingDecisions();
    appendStatus('waiting-work', 'work', verb, 'Continuing the work', new Date(Date.parse(card!.askedAt) + 1).toISOString());
    expect(() => answerKey(card!.key, { option: 'Allow once', by: 'glass' })).toThrow(/no decision/);
    expect(buildGlassSnapshot().decisions).toEqual([]);
    expect(listGrants().grants).toEqual([]);
  });

  it('retires an explicit dispatch proposal when its trap signs off', () => {
    claim();
    const registration = trapBySession(session)!;
    const card = askPermission({ dispatch: 'waiting-work', lane: 'work', ask: { command, harness: 'claude', trap: registration.name } });
    stowTrap(registration.trapId);
    expect(buildGlassSnapshot().decisions).toEqual([]);
    expect(() => answerKey(card.key, { option: 'Allow once', by: 'glass' })).toThrow(/no decision/);
    expect(listGrants().grants).toEqual([]);
  });
});

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
    run(['hook', 'permission-request'], {
      session_id: session,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command },
    });

  it('files a Codex cmd request as a permission card, and its always grant covers different arguments', () => {
    const registered = trap('codex-trap', 'codex');
    enqueue({ id: 'd-codex', repo: 'web', brief: 'push the plan' });
    expect(claimBait(trapBySession('codex-trap')!)?.id).toBe('d-codex');
    const command = 'ume push .temp/plan.html --session f6cc416c --project p --gate plan --title "Plan"';
    const input = { session_id: 'codex-trap', tool_name: 'functions.exec_command', tool_input: { cmd: command } };
    expect(run(['hook', 'permission-request'], input).stdout).toBe('');
    expect(run(['hook', 'permission-request'], input).stdout).toBe('');
    const cards = standingDecisions();
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.title).toBe(`${registered.name} wants to run: \`${command}\``);
    expect(c.optionNotes?.['Allow always']).toBe('`ume push …` (any arguments) for Codex traps');
    expect(readDecisionDetail(c.key)).toContain(command);
    answerKey(c.key, { option: 'Allow always', by: 'glass' });
    expect(listGrants().grants).toMatchObject([{ command: 'ume push', match: 'prefix', mode: 'always', harness: 'codex', by: 'glass' }]);
    const next = run(['hook', 'permission-request'], {
      ...input,
      tool_input: { cmd: 'ume push other.html --session other --gate verify' },
    });
    expect(JSON.parse(next.stdout)).toEqual(ALLOW);
    expect(standingDecisions()).toHaveLength(0);
  });

  it.each(['claude', 'codex'] as const)('lets a held %s report reach the helm without an Allow card', (harness) => {
    const session = `${harness}-report`;
    trap(session, harness);
    enqueue({ id: 'held-report', repo: 'web', brief: 'Choose the next step' });
    claimBait(trapBySession(session)!);
    const note = 'Pick B option 1, 2 or 3;\nthen confirm the read-only check.';
    const command = `lobstah report held-report needs-decision "${note}"`;
    const result = run(['hook', 'permission-request'], {
      session_id: session,
      tool_name: harness === 'claude' ? 'Bash' : 'functions.exec_command',
      tool_input: { command, description: 'Pick B option 1, 2 or 3' },
    });
    expect(JSON.parse(result.stdout)).toEqual(ALLOW);
    const delivered = run(['report', 'held-report', 'needs-decision', note], undefined);
    expect(delivered.status, delivered.stderr).toBe(0);
    expect(readStatusLog('held-report', 'work').at(-1)).toMatchObject({ verb: 'needs-decision', note });
    expect(standingDecisions()).toEqual([]);
  });

  it('does not treat a compound command or substitution as only a report', () => {
    trap('report-trap', 'claude');
    enqueue({ id: 'compound-report', repo: 'web', brief: 'Choose the next step' });
    claimBait(trapBySession('report-trap')!);
    for (const command of [
      'lobstah report compound-report working ok; npm publish',
      'lobstah report compound-report working "$(npm publish)"',
      'lobstah report compound-report working ok\nnpm publish',
      'lobstah report compound-report working ok # comment\\\nnpm publish',
    ]) {
      expect(ask('report-trap', command).stdout).toBe('');
    }
    expect(standingDecisions()).toHaveLength(4);
  });

  it('titles an Allow card with the command and labels the description separately', () => {
    const registered = trap('description-trap', 'claude');
    enqueue({ id: 'description-report', repo: 'web', brief: 'Inspect the build' });
    claimBait(trapBySession('description-trap')!);
    const command = 'ps -p 1842 -o pid,etime,command';
    const description = 'Pick B option 1, 2 or 3';
    run(['hook', 'permission-request'], {
      session_id: 'description-trap', tool_name: 'Bash', tool_input: { command, description },
    });
    const [card] = standingDecisions();
    expect(card!.title).toBe(`${registered.name} wants to run: \`${command}\``);
    expect(card!.title).not.toContain(description);
    expect(card!.permission?.command).toBe(command);
    const detail = readDecisionDetail(card!.key);
    expect(detail).toContain(`\`\`\`\n${command}\n\`\`\``);
    expect(detail).toContain(`**Trap's description:** ${description}`);
  });

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

  it("answers only for traps: the helm and a person's own session keep their normal approval", () => {
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
    const res = spawnSync(process.execPath, [cli, 'hook', 'permission-request'], {
      encoding: 'utf8',
      env: { ...process.env, LOBSTAH_HOME: home },
      input: 'not json',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('defers an uncovered Codex-shaped Linear request without a card; a later explicit request can ask a person', () => {
    const t = trap('linear-trap', 'codex');
    enqueue({ id: 'linear-job', repo: 'web', brief: 'Read the assigned issue' });
    claimBait(trapBySession('linear-trap')!);
    const input = {
      session_id: 'linear-trap', turn_id: 'codex-turn', hook_event_name: 'PermissionRequest',
      cwd: t.worktree, transcript_path: null, model: 'fixture-model', permission_mode: 'default',
      tool_name: 'mcp__codex_apps__linear__get_issue', tool_input: { id: 'fixture-issue' },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run(['hook', 'permission-request'], input);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(standingDecisions()).toEqual([]);
      expect(listGrants().grants).toEqual([]);
    }
    const request = run(['grant', 'request', '--session', 'linear-trap', '--tools', 'mcp__codex_apps__linear__*',
      '--reason', 'Codex refused the requested call; a person must decide'], undefined, { CODEX_THREAD_ID: 'linear-trap' });
    expect(request.status, request.stderr).toBe(0);
    expect(standingDecisions()[0]?.permission?.sessionGrant?.session).toBe('linear-trap');
    expect(listGrants().grants).toEqual([]);
  });

  it.each(['codex', 'claude', undefined] as const)('preserves %s helm connector behavior using its registered harness', (harness) => {
    takeHelm({ sessionId: 'connector-helm', grounds: { name: 'home', repos: [] }, ttlMs: 60_000, identity: { harness } });
    const result = run(['hook', 'permission-request'], {
      session_id: 'connector-helm', tool_name: 'mcp__codex_apps__linear__get_issue', tool_input: { id: 'fixture-issue' },
      ...(harness === 'codex' ? { turn_id: 'codex-turn' } : {}), cwd: home,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(standingDecisions()).toHaveLength(harness === 'codex' ? 0 : 1);
  });

  it('honors an existing Codex connector grant before deferring, and defers again after revocation', () => {
    const t = trap('granted-linear-trap', 'codex');
    enqueue({ id: 'granted-linear-job', repo: 'web', brief: 'Read the assigned issue' });
    claimBait(trapBySession('granted-linear-trap')!);
    const grant = addGrant({ mode: 'session', session: 'granted-linear-trap', tools: 'mcp__codex_apps__linear__*', by: 'glass' });
    const input = {
      session_id: 'granted-linear-trap', turn_id: 'codex-turn', hook_event_name: 'PermissionRequest',
      cwd: t.worktree, transcript_path: null, model: 'fixture-model', permission_mode: 'default',
      tool_name: 'mcp__codex_apps__linear__get_issue', tool_input: { id: 'fixture-issue' },
    };
    const allowed = run(['hook', 'permission-request'], input);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual(ALLOW);
    expect(listGrants().grants[0]?.uses).toBe(1);
    revokeGrant(grant.id, 'glass');
    const uncovered = run(['hook', 'permission-request'], input);
    expect(uncovered.status, uncovered.stderr).toBe(0);
    expect(uncovered.stdout).toBe('');
    expect(standingDecisions()).toEqual([]);
  });

  it('still files a file permission card for a Codex MCP call with a file target', () => {
    const t = trap('file-trap', 'codex');
    enqueue({ id: 'file-job', repo: 'web', brief: 'Write the file' });
    claimBait(trapBySession('file-trap')!);
    const file = path.join(t.worktree, 'fixture.txt');
    const result = run(['hook', 'permission-request'], {
      session_id: 'file-trap', turn_id: 'codex-turn', tool_name: 'mcp__files__write_file', tool_input: { file_path: file }, cwd: t.worktree,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(standingDecisions()[0]?.permission).toMatchObject({ path: file, harness: 'codex' });
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
  it('the real mod allows a matching helm tool ask, but preserves denials and immediate revocation', async () => {
    const g = addGrant({ mode: 'session', session: 'helm-session', tools: 'mcp__browser__*', hosts: ['example.com'], by: 'glass' });
    const { register } = await import(new URL('../../../plugins/claude-code/hooks/grants.mjs', import.meta.url).href);
    let handler: any;
    register((_event: unknown, _filter: unknown, fn: unknown) => { handler = fn; });
    const api = { env: { get: async (key: string) => key === 'LOBSTAH_HOME' ? home : os.homedir() }, fs: { exists: async (file: string) => fs.existsSync(file) }, session: { id: async () => 'helm-session', cwd: async () => home }, process: { run: async (_cmd: string[], opts: { stdin: string }) => { const r = run(['hook', 'grant-check'], JSON.parse(opts.stdin)); return { exitCode: r.status, stdout: r.stdout }; } } };
    const call = { tool: 'mcp__browser__navigate', input: { url: 'https://example.com/' }, tool_use_id: 'mod-call' };
    expect(await handler(api, call, async () => ({ decision: 'ask' }))).toMatchObject({ decision: 'allow' });
    expect(await handler(api, call, async () => ({ decision: 'deny' }))).toEqual({ decision: 'deny' });
    revokeGrant(g.id, 'glass');
    expect(await handler(api, call, async () => ({ decision: 'ask' }))).toEqual({ decision: 'ask' });
  });

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
  it('preserves native absolute file, notebook and patch targets without adding the working directory', () => {
    const file = path.join(home, 'src', 'fixture.ts');
    const calls = [
      { tool: 'Write', input: { file_path: file } },
      { tool: 'NotebookEdit', input: { notebook_path: file } },
      { tool: 'apply_patch', input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-x\n+y\n*** End Patch` } },
      { tool: 'apply_patch', input: { command: `*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: ${file}\n*** End Patch` } },
    ];
    for (const call of calls) {
      const requests = callRequests({ harness: 'codex', ...call }, 'kind-crab', home);
      expect(requests.at(-1)?.path).toBe(file);
    }
  });

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
    return askPermission({
      dispatch: 'd-1',
      lane: 'work',
      ask: { command: 'wrangler deploy', harness: 'codex', trap: t.name },
      note: 'The deploy was refused.',
    });
  }

  it('offers Allow once, Allow always and No, and shows the exact command', () => {
    const c = card();
    expect(c.options).toEqual(['Allow once', 'Allow always', 'Allow this tool family for 15 min', 'No']);
    expect(c.title).toMatch(/ wants to run: `wrangler deploy`$/);
    expect(readDecision(c.key)?.permission).toMatchObject({ command: 'wrangler deploy', harness: 'codex' });
  });

  it('truncates the command title while preserving the full command in the detail', () => {
    const command = `git diff -- ${'long-file-name/'.repeat(30)}file.ts`;
    const c = askPermission({ dispatch: 'long-command', lane: 'work', ask: { command, harness: 'codex', trap: 'early-cove' } });
    expect(c.title).toHaveLength(200);
    expect(c.title).toMatch(/^early-cove wants to run: `git diff -- .*…`$/);
    expect(readDecisionDetail(c.key)).toContain(command);
  });

  it('Allow once in the glass grants it to the asking trap, once, and tells the trap to retry exactly', () => {
    const c = card();
    answerKey(c.key, { option: 'Allow once', by: 'glass' });
    const [g] = listGrants().grants;
    expect(g).toMatchObject({
      command: 'wrangler deploy',
      match: 'exact',
      mode: 'once',
      harness: 'codex',
      by: 'glass',
      trap: c.permission!.trap,
      dispatch: 'd-1',
    });
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
    expect(listGrants().grants[0]).toMatchObject({
      path: 'apps/exterior-model-gen/ops/deploy/apply-exterior.sh',
      repo: 'homebase',
      mode: 'always',
    });
    const cmd = askPermission({ dispatch: 'd-1', lane: 'work', ask: { command: `cd ${wt}/bao && fastlane`, harness: 'claude' } });
    expect(cmd.optionNotes).toEqual({ 'Allow always': 'this command in any homebase worktree' });
    expect(askPermission({ dispatch: 'd-1', lane: 'work', ask: { path: '/etc/hosts', harness: 'claude' } }).optionNotes).toEqual({
      'Allow always': 'this exact path',
    });
    expect(card().optionNotes).toEqual({ 'Allow always': '`wrangler deploy …` (any arguments) for Codex traps' });
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

describe('a helm command auto mode refused', () => {
  const MERGE = 'gh pr merge 2681 --squash';
  const denied = (session: string, command: string, tool = 'Bash') =>
    run(['hook', 'permission-denied'], {
      session_id: session,
      hook_event_name: 'PermissionDenied',
      permission_mode: 'auto',
      tool_name: tool,
      tool_input: { command, description: 'Merge the glass sync PR' },
      tool_use_id: 'denied-call',
      reason: '[Merge Without Review]',
      cwd: home,
    });
  const preToolUse = (session: string, command: string) =>
    run(['hook', 'pre-tool-use'], { session_id: session, tool_name: 'Bash', tool_input: { command }, tool_use_id: `call-${command.length}`, cwd: home });

  it('becomes one glass card; Allow once mints a one-use grant for exactly that command in that helm session', () => {
    takeHelm({ sessionId: 'helm-session', grounds: { name: 'home', repos: [] }, ttlMs: 60_000, identity: { harness: 'claude' } });
    expect(denied('helm-session', MERGE)).toMatchObject({ status: 0, stdout: '' });
    denied('helm-session', MERGE);
    expect(standingDecisions()).toHaveLength(1);
    const card = standingDecisions()[0]!;
    expect(card.options).toEqual(['Allow once', 'No']);
    expect(card.permission).toMatchObject({ helm: true, session: 'helm-session', command: MERGE });
    expect(readDecisionDetail(card.key)).toContain('[Merge Without Review]');
    expect(preToolUse('helm-session', MERGE).stdout).toBe('');
    expect(() => answerKey(card.key, { option: 'Allow once', by: 'cli' })).toThrow('person');
    answerKey(card.key, { option: 'Allow once', by: 'glass' });
    expect(listGrants().grants).toMatchObject([{ mode: 'once', session: 'helm-session', command: MERGE, match: 'exact', by: 'glass' }]);
    expect(preToolUse('other-session', MERGE).stdout).toBe('');
    expect(preToolUse('helm-session', `${MERGE} --admin`).stdout).toBe('');
    expect(JSON.parse(preToolUse('helm-session', MERGE).stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    expect(preToolUse('helm-session', MERGE).stdout).toBe('');
    expect(listGrants({ all: true }).grants[0]?.uses).toBe(1);
  });

  it("files nothing for a trap or another session, another tool, or a command no grant may cover; No grants nothing", () => {
    takeHelm({ sessionId: 'helm-session', grounds: { name: 'home', repos: [] }, ttlMs: 60_000, identity: { harness: 'claude' } });
    trap('denied-trap', 'claude');
    denied('denied-trap', MERGE);
    denied('stranger', MERGE);
    denied('helm-session', MERGE, 'Write');
    denied('helm-session', `printf 'x' >> ${path.join(home, 'config.toml')}`);
    expect(standingDecisions()).toEqual([]);
    denied('helm-session', MERGE);
    answerKey(standingDecisions()[0]!.key, { option: 'No', by: 'glass' });
    expect(listGrants().grants).toEqual([]);
  });

  it("retires a denied trap call; a later retry card can still allow its PreToolUse in auto mode", () => {
    const t = trap('auto-trap', 'claude');
    enqueue({ id: 'auto-job', repo: 'web', brief: 'Land the PR' });
    claimBait(trapBySession('auto-trap')!);
    const request = (id: string) => run(['hook', 'permission-request'], {
      session_id: 'auto-trap', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: id, tool_input: { command: MERGE },
    });
    request('denied-call');
    denied('auto-trap', MERGE);
    denied('auto-trap', MERGE);
    expect(standingDecisions()).toHaveLength(0);
    request('retry-call');
    expect(standingDecisions()).toHaveLength(1);
    const card = standingDecisions()[0]!;
    expect(card).toMatchObject({ dispatch: 'auto-job', options: ['Allow once', 'Allow always', 'Allow this tool family for 15 min', 'No'] });
    expect(card.permission).toMatchObject({ command: MERGE, trap: t.name, session: 'auto-trap' });
    answerKey(card.key, { option: 'Allow once', by: 'glass' });
    const call = (mode: string) =>
      run(['hook', 'pre-tool-use'], { session_id: 'auto-trap', permission_mode: mode, tool_name: 'Bash', tool_input: { command: MERGE }, tool_use_id: `call-${mode}`, cwd: t.worktree });
    expect(call('default').stdout).toBe('');
    expect(JSON.parse(call('auto').stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    expect(call('auto').stdout).toBe('');
    addGrant({ ...commandGrantScope(MERGE), mode: 'always', harness: 'claude', by: 'glass' });
    expect(JSON.parse(call('auto').stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
  });

  it('a session command grant names one exact command, once', () => {
    expect(() => addGrant({ mode: 'once', session: 'helm-session', command: 'gh pr merge', match: 'prefix', by: 'glass' })).toThrow('exact');
    expect(() => addGrant({ mode: 'always', session: 'helm-session', command: MERGE, by: 'glass' })).toThrow('exact');
  });
});

describe("a grant is a person's act", () => {
  it('refuses inside an agent session, and without a terminal', () => {
    expect(() => personOnly('lobstah grant', { CLAUDECODE: '1' }, true)).toThrow(/not an agent session/);
    expect(() => personOnly('lobstah grant', { CODEX_THREAD_ID: 't' }, true)).toThrow(/not an agent session/);
    expect(() => personOnly('lobstah grant', {}, false)).toThrow(/needs a terminal/);
    expect(() => personOnly('lobstah grant', {}, true)).not.toThrow();
    const res = run(['grant', 'npm', 'publish'], undefined);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toMatch(/no terminal to confirm; re-run with --yes/);
    expect(listGrants().grants).toEqual([]);
  });
});

describe("bypass is a person's choice", () => {
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

  it("a person at a terminal saves bypass in the roster; clearing it is anyone's", () => {
    expect(rosterConfigPatch(['permissionMode=bypass', 'effort=high'], {}, true)).toEqual({
      config: { permissionMode: 'bypassPermissions', effort: 'high' },
      bypass: true,
    });
    expect(rosterConfigPatch(['bypass=true'], {}, true).bypass).toBe(true);
    expect(() => rosterConfigPatch(['permissionMode=bypass'], { CLAUDECODE: '1' }, true)).toThrow(/not an agent session/);
    expect(() => rosterConfigPatch(['permissionMode=bypassPermissions'], {}, false)).toThrow(/needs a terminal/);
    expect(rosterConfigPatch(['permissionMode=', 'bypass='], { CLAUDECODE: '1' }, false)).toEqual({
      config: { permissionMode: null, bypass: null },
      bypass: false,
    });
    expect(rosterConfigPatch(['permissionMode=auto'], { CLAUDECODE: '1' }, false).bypass).toBe(false);
  });
});

describe('a bypass trap', () => {
  it('starts with no permission checks in either harness', () => {
    const claude = harnessCommand({ harness: 'claude', cwd: home, ticket: 't', config: { bypass: 'true', permissionMode: 'auto' } });
    expect(claude.argv).toEqual(['claude', '--dangerously-skip-permissions', '/lobstah:trap soak --ticket t']);
    expect(claude.unapplied).toEqual([]);
    const codex = harnessCommand({ harness: 'codex', cwd: home, ticket: 't', config: { bypass: 'true' } });
    expect(codex.argv).toEqual(['codex', '--cd', home, '-c', 'tui.terminal_title=[]', '--dangerously-bypass-approvals-and-sandbox', '$lobstah:trap soak --ticket t']);
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
    let offset = 0;
    return (buf: Buffer) => {
      if (calls++ < waits) throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, read'), { code: 'EAGAIN' });
      if (line instanceof Error) throw line;
      if (offset >= line.length) return 0;
      return buf.write(line[offset++]!);
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

  it('n and an empty line are no; EOF without a terminal is an error', () => {
    expect(ask(terminal('n\n'))).toBe(false);
    expect(ask(terminal('\n'))).toBe(false);
    expect(() => ask(terminal(''))).toThrow(/no terminal to confirm; re-run with --yes/);
  });

  it('a read that fails is an error, never a silent no', () => {
    expect(() => ask(terminal(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })))).toThrow(
      /could not read your answer: EIO/,
    );
  });
});

describe('session grants', () => {
  it('an agent can request but cannot grant; a glass click grants only the requested session', async () => {
    const r = run(['grant', 'request', '--session', 'helm-session', '--tools', 'mcp__browser__*', '--hosts', 'example.com', '--reason', 'Inspect the site'], undefined, { CLAUDECODE: '1' });
    expect(r.status, r.stderr).toBe(0); expect(listGrants().grants).toEqual([]);
    const c = standingDecisions()[0]!; expect(c.options).toEqual(['Allow for 15m', 'Allow for 1h', 'Deny']);
    expect(() => answerKey(c.key, { option: 'Allow for 15m', by: 'cli' })).toThrow('person');
    answerKey(c.key, { option: 'Allow for 15m', by: 'glass' });
    expect(listGrants().grants[0]).toMatchObject({ mode: 'session', session: 'helm-session', tools: 'mcp__browser__*', hosts: ['example.com'] });
    const h = { session_id: 'helm-session', tool_name: 'mcp__browser__navigate', tool_input: { url: 'https://example.com/private?token=secret' }, tool_use_id: 'once-id', cwd: home };
    expect(JSON.parse(run(['hook', 'pre-tool-use'], h).stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    expect(JSON.parse(run(['hook', 'permission-request'], h).stdout)).toEqual(ALLOW);
    expect(listGrants().grants[0]?.uses).toBe(1);
    expect(run(['hook', 'permission-request'], { ...h, session_id: 'other' }).stdout).toBe('');
    expect(run(['hook', 'permission-request'], { ...h, tool_input: { url: 'https://evil.example/' } }).stdout).toBe('');
    expect(run(['grant', '--session', 'helm-session', '--tools', 'WebFetch', '--yes'], undefined, { CLAUDECODE: '1' }).status).not.toBe(0);
  });
  it('an uncovered Claude browser call still files a session request with host pins', () => {
    const t = trap('browser-trap', 'claude');
    enqueue({ id: 'browser-job', repo: 'web', brief: 'Read the page' }); claimBait(trapBySession('browser-trap')!);
    run(['hook', 'permission-request'], { session_id: 'browser-trap', tool_name: 'mcp__browser__navigate', tool_input: { url: 'https://example.com/private' }, cwd: t.worktree });
    expect(standingDecisions()[0]?.permission?.sessionGrant).toMatchObject({ session: 'browser-trap', tools: 'mcp__browser__*', hosts: ['example.com'] });
    expect(standingDecisions()[0]?.repo).toBe('web');
    expect(readDecisionDetail(standingDecisions()[0]!.key)).toContain(`Trap: web · ${t.name}`);
  });
  it("Allow always on a trap's requested tool card covers that tool in every trap and later session, with no new card", () => {
    const claimed = (session: string): { name: string; worktree: string } => {
      const t = trap(session, 'codex');
      enqueue({ id: `${session}-job`, repo: 'web', brief: 'Read the issue' });
      claimBait(trapBySession(session)!);
      return t;
    };
    const linear = (session: string, cwd: string, tool = 'mcp__codex_apps__linear__get_issue') =>
      run(['hook', 'permission-request'], { session_id: session, tool_name: tool, tool_input: { id: 'BAS-1' }, cwd });
    const first = claimed('linear-trap');
    expect(linear('linear-trap', first.worktree).stdout).toBe('');
    expect(standingDecisions()).toEqual([]);
    const requested = run(['grant', 'request', '--session', 'linear-trap', '--tools', 'mcp__codex_apps__linear__*', '--reason', 'Allow the requested connector family']);
    expect(requested.status, requested.stderr).toBe(0);
    const c = standingDecisions().find((d) => d.permission?.sessionGrant?.tools === 'mcp__codex_apps__linear__*')!;
    expect(c.options).toEqual(['Allow for 15m', 'Allow for 1h', 'Allow always', 'Deny']);
    expect(() => answerKey(c.key, { option: 'Allow always', by: 'cli' })).toThrow('person');
    expect(listGrants().grants).toEqual([]);
    answerKey(c.key, { option: 'Allow always', by: 'glass' });
    const [g] = listGrants().grants;
    expect(g).toMatchObject({ mode: 'always', tools: 'mcp__codex_apps__linear__*', by: 'glass' });
    expect(g?.session).toBeUndefined();
    expect(g?.expiresAt).toBeUndefined();
    const later = claimed('later-trap');
    const cards = standingDecisions().length;
    expect(JSON.parse(linear('later-trap', later.worktree, 'mcp__codex_apps__linear__list_issues').stdout)).toEqual(ALLOW);
    expect(JSON.parse(linear('linear-trap', first.worktree).stdout)).toEqual(ALLOW);
    expect(standingDecisions()).toHaveLength(cards);
    expect(listGrants().grants[0]?.uses).toBe(2);
    expect(linear('later-trap', later.worktree, 'mcp__codex_apps__github__get_pr').stdout).toBe('');
    expect(linear('not-a-trap', home).stdout).toBe('');
  });

  it('a standing tool grant never names a shell or file tool', () => {
    for (const tools of ['Bash', 'exec_command', 'Write', 'apply_patch', '*', 'mcp__*__Bash'])
      expect(() => addGrant({ mode: 'always', tools, by: 'glass' })).toThrow(/command or path|tool glob/);
    expect(addGrant({ mode: 'always', tools: 'mcp__codex_apps__linear__*', by: 'glass' })).toMatchObject({ mode: 'always', harness: 'any' });
  });

  it('custom Claude and Codex settings locations remain protected by session grants', () => {
    addGrant({ mode: 'session', session: 'settings-session', tools: 'Write', by: 'glass' });
    for (const [variable, name] of [['CLAUDE_CONFIG_DIR', 'settings.json'], ['CODEX_HOME', 'config.toml']]) {
      const settingsRoot = path.join(home, variable.toLowerCase(), 'not-created-yet');
      const h = { session_id: 'settings-session', tool_name: 'Write', tool_input: { file_path: path.join(settingsRoot, name!), content: '{}' }, cwd: home };
      expect(run(['hook', 'permission-request'], h, { [variable!]: settingsRoot }).stdout).toBe('');
    }
  });

  it('PreToolUse does not spend a legacy once grant before a permission request needs it', () => {
    trap('legacy-trap', 'claude');
    addGrant({ command: 'echo fixture', mode: 'once', trap: trapBySession('legacy-trap')!.name, by: 'glass' });
    const h = { session_id: 'legacy-trap', tool_name: 'Bash', tool_input: { command: 'echo fixture' }, cwd: home };
    expect(run(['hook', 'pre-tool-use'], h).stdout).toBe('');
    expect(listGrants().grants[0]?.uses).toBe(0);
    expect(JSON.parse(run(['hook', 'permission-request'], h).stdout)).toEqual(ALLOW);
  });

  it('the old command card adds a 15-minute tool family option scoped to the asking session', () => {
    const t = trap('family-trap', 'claude');
    const c = askPermission({ dispatch: 'd-family', lane: 'work', ask: { command: 'npx wrangler deploy --dry-run', harness: 'claude', trap: t.name } });
    expect(c.options).toContain('Allow this tool family for 15 min');
    answerKey(c.key, { option: 'Allow this tool family for 15 min', by: 'glass' });
    expect(listGrants().grants[0]).toMatchObject({ mode: 'session', session: 'family-trap', tools: 'Bash', command: 'npx wrangler deploy --dry-run' });
  });
  it('Deny writes no grant and malformed duration/host requests fail before creating a card', () => {
    const r = run(['grant', 'request', '--session', 's', '--tools', 'WebFetch', '--for', '5h', '--reason', 'Read'], undefined);
    expect(r.status).not.toBe(0); expect(standingDecisions()).toEqual([]);
    const ok = run(['grant', 'request', '--session', 's', '--tools', 'WebFetch', '--reason', 'Read'], undefined);
    expect(ok.status).toBe(0); answerKey(standingDecisions()[0]!.key, { option: 'Deny', by: 'glass' }); expect(listGrants().grants).toEqual([]);
  });
});
