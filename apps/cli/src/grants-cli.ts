import {
  GrantError,
  listTraps,
  listHelms,
  sessionGuarded,
  toolHosts,
  validateSessionGrant,
  PERMISSION_OPTIONS,
  addGrant,
  alwaysScope,
  commandGrantScope,
  askDecision,
  checkoutRoots,
  grantCovers,
  listGrants,
  loadConfig,
  parseUntil,
  revokeGrant,
  readSessionClaim,
  rosterByAddress,
  setRosterProfile,
  sendMessage,
  standingDecisions,
  trapBySession,
  toonKV,
  toonTable,
  useGrant,
} from '@lobstah/core';
import type {
  AnswerSource,
  CheckoutRoot,
  DecisionAnswer,
  DecisionMeta,
  Grant,
  GrantHarness,
  GrantMode,
  GrantRequest,
  Lane,
  PermissionAsk,
} from '@lobstah/core';
import * as fs from 'node:fs';
import * as os from 'node:os';

/**
 * Grants from the command line and the hooks: a person grants, revokes and
 * lists; the Claude Code mod and the Codex PermissionRequest hook ask the
 * ledger whether a trap's call is covered; a trap files a permission card;
 * a glass answer to that card writes the grant and tells the trap.
 */

/** Environment variables a harness sets in the shells its agent runs. */
const AGENT_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'CODEX_MANAGED_BY_NPM_SESSION',
];

/**
 * A grant is a person's act. Refuse when the command runs without a terminal
 * (an agent's tool call has none) or inside an agent's shell. This keeps an
 * agent from granting itself; the harness checks, which see the agent run
 * the command, are the other half.
 */
export function personOnly(
  action: string,
  env: NodeJS.ProcessEnv = process.env,
  tty = !!process.stdin.isTTY && !!process.stdout.isTTY,
): void {
  refuseAgentSession(action, env);
  if (!tty) throw new GrantError(`${action} needs a terminal: a person grants, at a terminal or in the glass.`);
}

function refuseAgentSession(action: string, env: NodeJS.ProcessEnv = process.env): void {
  const agent = agentSession(env);
  if (agent)
    throw new GrantError(
      `${action} is for a person, not an agent session (${agent} is set). Grant in the glass, or run it in your own terminal.`,
    );
}

/** The harness variable that marks this shell as an agent's, if any. */
export function agentSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return AGENT_ENV.find((k) => env[k] !== undefined);
}

/**
 * One line of the person's answer from stdin. Reading `process.stdin` at all
 * (even `isTTY`) leaves a terminal's stdin non-blocking, so a read gets
 * EAGAIN until a line is typed: that means "not yet", never "no". End of
 * input without an answer or a terminal is an error; other read errors
 * also fail explicitly, never as a silent no.
 */
export function readAnswer(read: (buf: Buffer) => number = (buf) => fs.readSync(0, buf, 0, buf.length, null)): string {
  const buf = Buffer.alloc(1);
  let answer = '';
  for (;;) {
    try {
      if (read(buf) === 0) {
        if (!answer.trim() && !process.stdin.isTTY) throw new GrantError('no terminal to confirm; re-run with --yes');
        return answer;
      }
      const char = buf.toString('utf8');
      if (char === '\n') return answer;
      answer += char;
    } catch (err) {
      if (err instanceof GrantError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') throw new GrantError(`could not read your answer: ${(err as Error).message}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** Ask the person to confirm at the terminal; only y or yes is a yes. */
export function confirm(question: string, read?: (buf: Buffer) => number): boolean {
  process.stdout.write(`${question} [y/N] `);
  return /^\s*y(es)?\s*$/i.test(readAnswer(read));
}

const localPerson = (): string => `local:${os.userInfo().username}`;

function harnessOf(v: string | undefined): GrantHarness {
  if (v === undefined) return 'any';
  if (v !== 'claude' && v !== 'codex' && v !== 'any') throw new GrantError('--harness takes claude, codex or any');
  return v;
}

function what(g: Pick<Grant, 'command' | 'match' | 'path' | 'repo' | 'tools' | 'session'>): string {
  if (g.tools) return `${g.tools}${g.command ? ` (${g.command} …)` : ''} for session ${g.session}`;
  if (g.path !== undefined) return g.repo !== undefined ? `write ${g.path} in any ${g.repo} checkout` : `write ${g.path}`;
  return g.match === 'prefix' ? `${g.command} …` : g.command!;
}

/** A long repo-relative path with its middle folded: `apps/…/apply-exterior.sh`. */
function shortPath(rel: string): string {
  const parts = rel.replace(/\/$/, '').split('/');
  const short = parts.length > 3 ? `${parts[0]}/…/${parts[parts.length - 1]}` : parts.join('/');
  return rel.endsWith('/') ? `${short}/` : short;
}

/**
 * What "Allow always" grants, as the card says it: the repo-relative path in
 * any checkout of its repo, the command from any of its repos' checkouts, or
 * the exact thing where no repo holds it.
 */
export function alwaysScopeText(
  ask: Pick<PermissionAsk, 'command' | 'path'>,
  roots: readonly CheckoutRoot[] = checkoutRoots(),
): { short: string; long: string } {
  if (ask.command !== undefined) {
    const { command, repos } = alwaysScope({ command: ask.command }, roots) as { command: string; repos: string[] };
    if (repos.length === 0) return { short: 'this exact command, from any trap', long: 'this exact command, from any trap' };
    const where = repos.join(' or ');
    return {
      short: `this command in any ${where} worktree`,
      long: `\`${command.replace(/\s+/g, ' ')}\`, with any ${where} worktree or checkout in place of \`{repo:…}\`,`,
    };
  }
  const scoped = alwaysScope({ path: ask.path! }, roots) as { path: string; repo?: string };
  if (scoped.repo === undefined) return { short: 'this exact path', long: `exactly \`${scoped.path}\`` };
  return {
    short: `${shortPath(scoped.path)} in any ${scoped.repo} worktree`,
    long: `\`${scoped.path}\` in any ${scoped.repo} worktree or checkout`,
  };
}

function permissionScopeText(ask: PermissionAsk): { short: string; long: string } {
  if (ask.command !== undefined) {
    const scope = commandGrantScope(ask.command);
    if (scope.match === 'prefix') {
      const who = ask.harness === 'any' ? 'traps' : `${ask.harness === 'codex' ? 'Codex' : 'Claude Code'} traps`;
      const text = `\`${scope.command} …\` (any arguments) for ${who}`;
      return { short: text, long: text };
    }
  }
  return alwaysScopeText(ask);
}

/** `lobstah grant <command> [--prefix] [--once] [--harness] [--expires] [--path <p>] [--trap <name>]`. */
export function grantCommand(opts: {
  command?: string;
  path?: string;
  prefix: boolean;
  once: boolean;
  harness?: string;
  expires?: string;
  trap?: string;
  yes?: boolean;
}): void {
  refuseAgentSession('lobstah grant');
  const mode: GrantMode = opts.once ? 'once' : 'always';
  const harness = harnessOf(opts.harness);
  const expiresAt = opts.expires !== undefined ? parseUntil(opts.expires) : undefined;
  const shown =
    opts.path !== undefined
      ? `writes to ${opts.path}`
      : `\`${opts.command}\`${opts.prefix ? ' and the same command with more arguments' : ''}`;
  const scope = mode === 'always' ? alwaysScopeText(opts.path !== undefined ? { path: opts.path } : { command: opts.command }).short : '';
  const warn = mode === 'always' ? `every trap may run it without asking (${scope}), until you revoke it` : 'one trap may run it once';
  if (!opts.yes && !confirm(`Allow ${shown} (${harness === 'any' ? 'Claude Code and Codex' : harness}); ${warn}?`)) {
    console.log('not granted');
    return;
  }
  const g = addGrant({
    ...(opts.path !== undefined ? { path: opts.path } : { command: opts.command, match: opts.prefix ? 'prefix' : 'exact' }),
    mode,
    harness,
    by: localPerson(),
    ...(opts.trap ? { trap: opts.trap } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  });
  console.log(
    toonKV({
      granted: g.id,
      what: what(g),
      mode: g.mode,
      harness: g.harness,
      ...(g.trap ? { trap: g.trap } : {}),
      ...(g.expiresAt ? { expires: g.expiresAt } : {}),
      by: g.by,
    }),
  );
}

/** `lobstah grants [--all] [--json]`: what a person has granted, with who, when and how often used. */
export function grantsCommand(opts: { all: boolean; json: boolean }): void {
  const { grants, intact, problem } = listGrants({ all: opts.all });
  if (opts.json) {
    console.log(JSON.stringify({ intact, ...(problem ? { problem } : {}), grants }, null, 2));
    return;
  }
  if (!intact) console.log(toonKV({ warning: `the grants ledger is damaged (${problem}): no grant is honoured until it is repaired` }));
  console.log(
    toonTable(
      'grants',
      grants.map((g) => ({
        id: g.id,
        what: what(g),
        mode: g.mode,
        harness: g.harness,
        trap: g.trap ?? '',
        session: g.session ?? '',
        hosts: g.hosts?.join(', ') ?? '',
        audit: g.audit?.map((a) => `${a.at} ${a.tool}${a.hosts?.length ? ` ${a.hosts.join(',')}` : ''}`).join(' | ') ?? '',
        by: g.by,
        at: g.at,
        uses: g.uses,
        expires: g.expiresAt ?? '',
        ...(opts.all ? { revoked: g.revokedAt ?? '' } : {}),
      })),
      [
        'id',
        'what',
        'mode',
        'harness',
        'trap',
        'session',
        'hosts',
        'by',
        'at',
        'uses',
        'expires',
        'audit',
        ...(opts.all ? ['revoked'] : []),
      ],
    ),
  );
}

/** `lobstah revoke <id>`: anyone may take a permission away. */
export function revokeCommand(id: string): void {
  const g = revokeGrant(id, AGENT_ENV.some((k) => process.env[k] !== undefined) ? 'agent' : localPerson());
  console.log(toonKV({ revoked: g.id, what: what(g), at: g.revokedAt! }));
}

/** A call as a harness hook or mod hands it over: the tool and its arguments. */
interface CallInput {
  harness: 'claude' | 'codex';
  tool: string;
  input: Record<string, unknown>;
  session?: string;
  callId?: string;
}

/** The files an `apply_patch` call touches, from its patch text. */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) paths.push((m[1] ?? m[2]!).trim());
  return paths;
}

/**
 * The grant requests one call makes: one for a shell command, one per file
 * for a write. A call is covered only when every request is.
 */
export function callRequests(call: CallInput, trap: string | undefined, cwd: string): GrantRequest[] {
  const tool = call.tool.split('.').at(-1);
  const base = { harness: call.harness, tool: tool!, ...(trap ? { trap } : {}) };
  const raw = call.input.command ?? call.input.cmd;
  if (tool === 'Bash' || tool === 'shell' || tool === 'exec_command') {
    const command = Array.isArray(raw) ? raw.map(String).join(' ') : typeof raw === 'string' ? raw : undefined;
    return command ? [{ ...base, command }] : [];
  }
  if (tool === 'apply_patch') {
    const patch = typeof raw === 'string' ? raw : typeof call.input.patch === 'string' ? (call.input.patch as string) : '';
    return patchPaths(patch).map((p) => ({ ...base, path: p.startsWith('/') ? p : `${cwd}/${p}` }));
  }
  const file = call.input.file_path ?? call.input.notebook_path;
  if (typeof file === 'string') return [{ ...base, path: file.startsWith('/') ? file : `${cwd}/${file}` }];
  return [];
}

/**
 * Is this call covered by grants? Only a signed-on trap's calls are: a
 * grant is for traps, never for the helm or a person's own session. Every
 * request the call makes must be covered; each covering grant's use is
 * recorded. Returns the grant ids that covered it, or nothing.
 */
export function checkCall(call: CallInput, cwd: string, sessionOnly = false): string[] | undefined {
  const trap = call.session ? trapBySession(call.session) : undefined;
  if (call.session) {
    const raw = call.input.command ?? call.input.cmd;
    const command = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(String).join(' ') : undefined;
    const knownHarness = trap?.harness ?? listHelms().find((h) => h.sessionId === call.session)?.harness;
    const req: GrantRequest = {
      harness: knownHarness === 'claude' || knownHarness === 'codex' ? knownHarness : call.harness,
      tool: call.tool,
      session: call.session,
      input: call.input,
      cwd,
      ...(command ? { command } : {}),
    };
    const paths = callRequests(call, trap?.name, cwd);
    const grant = paths.some((p) => sessionGuarded({ ...req, ...p }))
      ? undefined
      : useGrant(req, { session: call.session, callId: call.callId });
    if (grant?.mode === 'session') return [grant.id];
  }
  if (sessionOnly || !trap) return undefined;
  // The trap's own harness, as it signed on: the hook entry is shared by both plugins.
  const harness = trap.harness === 'codex' ? 'codex' : trap.harness === 'claude' ? 'claude' : call.harness;
  const requests = callRequests({ ...call, harness }, trap.name ?? trap.trapId, cwd);
  if (requests.length === 0) return undefined;
  // Check every request before spending any: a once-grant is not spent on a call that is refused anyway.
  const { grants, intact } = listGrants();
  const roots = checkoutRoots();
  if (!intact || !requests.every((req) => grants.some((g) => grantCovers(g, req, roots)))) return undefined;
  const ids: string[] = [];
  for (const req of requests) {
    const g = useGrant(req, { session: call.session });
    if (!g) return undefined;
    ids.push(g.id);
  }
  return ids;
}

/** Read a hook's JSON from stdin; undefined when there is none. */
function readStdinJson(): Record<string, unknown> | undefined {
  try {
    const text = fs.readFileSync(0, 'utf8');
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `lobstah hook grant-check`: the Claude Code mod's question. Input:
 * `{ tool, input, session, cwd }`. Prints `{"grants":[...]}` when grants
 * cover the call, `{}` otherwise. Never fails: an error means no grant.
 */
export function grantCheckHook(): void {
  try {
    const q = readStdinJson();
    if (!q || typeof q.tool !== 'string' || typeof q.input !== 'object' || q.input === null) return void console.log('{}');
    const ids = checkCall(
      {
        harness: 'claude',
        tool: q.tool,
        input: q.input as Record<string, unknown>,
        ...(typeof q.callId === 'string' ? { callId: q.callId } : {}),
        ...(typeof q.session === 'string' ? { session: q.session } : {}),
      },
      typeof q.cwd === 'string' ? q.cwd : process.cwd(),
    );
    console.log(JSON.stringify(ids ? { grants: ids } : {}));
  } catch {
    console.log('{}');
  }
}

/**
 * `lobstah hook permission-request`: the PermissionRequest hook of both
 * plugins. With a grant that covers a trap's call it allows it: in Codex
 * before the approval reviewer, in Claude Code where a permission prompt
 * would show (the mod covers auto mode). Otherwise it prints nothing, and
 * the normal approval flow goes on. An uncovered call from an assigned trap
 * also files a permission card, so its glass answer writes a real grant.
 */
export function permissionRequestHook(preToolUse = false, preHarness: 'claude' | 'codex' = 'claude'): void {
  try {
    const h = readStdinJson();
    if (!h || typeof h.tool_name !== 'string' || typeof h.tool_input !== 'object' || h.tool_input === null) return;
    const call: CallInput = {
      harness: preToolUse ? (typeof h.turn_id === 'string' ? 'codex' : preHarness) : 'codex',
      tool: h.tool_name,
      ...(typeof h.tool_use_id === 'string' ? { callId: h.tool_use_id } : {}),
      input: h.tool_input as Record<string, unknown>,
      ...(typeof h.session_id === 'string' ? { session: h.session_id } : {}),
    };
    const cwd = typeof h.cwd === 'string' ? h.cwd : process.cwd();
    const ids = checkCall(call, cwd, preToolUse);
    if (ids) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: preToolUse
            ? { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `lobstah grant ${ids.join(', ')}` }
            : { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
        }),
      );
      return;
    }
    const trap = call.session ? trapBySession(call.session) : undefined;
    if (preToolUse) return;
    if (!trap?.claimed) {
      if (
        call.session &&
        listHelms().some((h) => h.sessionId === call.session) &&
        !standingDecisions().some(
          (d) => d.permission?.sessionGrant?.session === call.session && d.permission?.sessionGrant?.tools === toolFamily(call.tool),
        )
      ) {
        requestSessionGrant({
          session: call.session,
          tools: toolFamily(call.tool),
          reason: 'The helm needs permission for this tool family',
          ...(call.tool === 'Bash' && typeof call.input.command === 'string'
            ? { command: commandGrantScope(call.input.command).command }
            : {}),
          hosts: toolHosts(call.input).hosts,
        });
      }
      return;
    }
    const lane = (['work', 'chore'] as const).find((lane) => readSessionClaim(trap.claimed!, lane)?.by === `wt:${trap.trapId}`);
    if (!lane) return;
    const harness = trap.harness === 'claude' ? 'claude' : 'codex';
    if (!callRequests(call, trap.name, cwd).length && call.session) {
      const tools = toolFamily(call.tool);
      if (
        !standingDecisions().some(
          (d) => d.permission?.sessionGrant?.session === call.session && d.permission?.sessionGrant?.tools === tools,
        )
      )
        requestSessionGrant({
          session: call.session,
          tools,
          hosts: toolHosts(call.input).hosts,
          reason: 'This tool call needs permission',
        });
      return;
    }
    for (const request of callRequests({ ...call, harness }, trap.name ?? trap.trapId, cwd)) {
      if (listGrants().grants.some((g) => grantCovers(g, request))) continue;
      const duplicate = standingDecisions().some(
        (d) =>
          d.dispatch === trap.claimed &&
          d.permission?.harness === harness &&
          d.permission.command === request.command &&
          d.permission.path === request.path,
      );
      if (!duplicate)
        askPermission({
          dispatch: trap.claimed,
          lane,
          repo: trap.repo,
          ask: {
            ...(request.command !== undefined ? { command: request.command } : { path: request.path! }),
            harness,
            session: call.session,
            tool: call.tool,
            trap: trap.name ?? trap.trapId,
          },
        });
    }
  } catch {
    /* no decision: the normal approval flow */
  }
}

/** File a trap's permission request as a card with Allow once, Allow always and No. */
export function askPermission(opts: { dispatch: string; lane: Lane; repo?: string; ask: PermissionAsk; note?: string }): DecisionMeta {
  const session = opts.ask.session ?? listTraps().find((t) => t.name === opts.ask.trap || t.trapId === opts.ask.trap)?.sessionId;
  if (session) opts.ask = { ...opts.ask, session, tool: opts.ask.tool ?? (opts.ask.command ? 'Bash' : 'Write') };
  const target = opts.ask.command !== undefined ? opts.ask.command : opts.ask.path!;
  const kind = opts.ask.command !== undefined ? 'run' : 'write to';
  const scope = permissionScopeText(opts.ask);
  let family = !!session;
  if (family && opts.ask.command) {
    try {
      validateSessionGrant({
        mode: 'session',
        session,
        tools: 'Bash',
        command: commandGrantScope(opts.ask.command).command,
        match: 'prefix',
        by: 'request',
      });
    } catch {
      family = false;
    }
  }
  const title =
    opts.ask.command !== undefined ? `Allow: ${commandGrantScope(target).command}` : `Allow ${kind}: ${target.replace(/\s+/g, ' ')}`;
  const detail = [
    opts.note ? `${opts.note}\n` : '',
    `The trap asks to ${kind} exactly this${opts.ask.harness === 'any' ? '' : ` (${opts.ask.harness === 'claude' ? 'Claude Code' : 'Codex'})`}:`,
    '',
    '```',
    target,
    '```',
    '',
    `- **Allow once**: this trap may ${kind} it once, within the hour.`,
    `- **Allow always**: ${scope.long}; without asking, until you revoke it (\`lobstah revoke <id>\`; \`lobstah grants\` lists them).`,
    ...(family
      ? [
          `- **${TOOL_FAMILY_OPTION}**: tool \`${toolFamily(opts.ask.tool ?? (opts.ask.command ? 'Bash' : 'Write'))}\` for session \`${session}\` only, with the shown command prefix when applicable; expires automatically.`,
        ]
      : []),
    '- **No**: the trap is told not to.',
  ].join('\n');
  return askDecision({
    title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
    detailText: detail,
    options: [...PERMISSION_OPTIONS.slice(0, 2), ...(family ? [TOOL_FAMILY_OPTION] : []), 'No'],
    optionNotes: { 'Allow always': scope.short },
    dispatch: opts.dispatch,
    lane: opts.lane,
    ...(opts.repo ? { repo: opts.repo } : {}),
    askedBy: 'worker',
    permission: opts.ask,
    maxBytes: loadConfig().limits.attachmentMaxBytes,
  }).meta;
}

/**
 * Before a permission card is answered: only a person may allow, in the
 * glass or through the wharf (a verified answer this boat agreed to take,
 * checked in wharf-answers.ts before it arrives here). An answer from the
 * command line (`man answer`, which the helm runs) may say No but never
 * grants.
 */
export function permissionAnswerAllowed(decision: DecisionMeta, option: string | undefined, by: AnswerSource): void {
  if (!decision.permission || by === 'glass' || by === 'wharf') return;
  if (option?.startsWith('Allow')) {
    throw new GrantError(
      'a permission is granted in the glass, or by a person with `lobstah grant` at a terminal; `man answer` can only say No',
    );
  }
}

/**
 * After a permission card is answered by a person, in the glass or through
 * the wharf: write the grant and tell the trap. "Allow once" is good for the
 * asking trap alone; "Allow always" for every trap. A wharf answer's grant is
 * by `wharf:<receipt>`: the same receipt finds its grant again rather than
 * writing a second.
 */
export function applyPermissionAnswer(decision: DecisionMeta, answer: DecisionAnswer): Grant | undefined {
  const ask = decision.permission;
  if (!ask) return undefined;
  const person = answer.by === 'glass' || answer.by === 'wharf';
  const grantedBy = answer.by === 'wharf' ? `wharf:${answer.receipt}` : 'glass';
  const where = answer.by === 'wharf' ? 'through the wharf' : 'in the glass';
  if (answer.by === 'wharf') {
    const earlier = listGrants({ all: true }).grants.find((g) => g.by === grantedBy);
    if (earlier) return earlier;
  }
  /** Every grant this answer writes names who allowed it. */
  const grantFromAnswer = (g: Omit<Parameters<typeof addGrant>[0], 'by'>) => addGrant({ ...g, by: grantedBy });
  if (person && ask.sessionGrant && answer.option?.startsWith('Allow for')) {
    const r = ask.sessionGrant;
    const duration = answer.option === 'Allow for 1h' ? 3600_000 : r.durationMs;
    return grantFromAnswer({
      mode: 'session',
      session: r.session,
      tools: r.tools,
      hosts: r.hosts,
      reason: r.reason,
      ...(r.command ? { command: r.command, match: 'prefix' } : {}),
      expiresAt: new Date(Date.now() + duration).toISOString(),
    });
  }
  if (person && answer.option === TOOL_FAMILY_OPTION && ask.session) {
    const grant = grantFromAnswer({
      mode: 'session',
      session: ask.session,
      tools: toolFamily(ask.tool ?? (ask.command ? 'Bash' : 'Write')),
      ...(ask.command ? { command: commandGrantScope(ask.command).command, match: 'prefix' } : {}),
      harness: ask.harness,
      reason: 'Allowed this tool family on the permission card',
    });
    if (decision.dispatch)
      sendMessage(
        decision.dispatch,
        decision.lane ?? 'work',
        `Chris allowed this tool family for 15 minutes: grant ${grant.id}. Retry the call; lobstah grants shows its scope and expiry.`,
        'glass',
      );
    return grant;
  }
  if (!decision.dispatch) return undefined;
  const lane: Lane = decision.lane ?? 'work';
  const target = ask.command !== undefined ? `\`${ask.command}\`` : `writes to ${ask.path}`;
  if (!person || (answer.option !== 'Allow once' && answer.option !== 'Allow always')) {
    if (answer.option === 'No')
      sendMessage(
        decision.dispatch,
        lane,
        `Chris answered No to ${target}. Do not run it. Carry on without it, or report what you need instead.`,
        'glass',
      );
    return undefined;
  }
  const once = answer.option === 'Allow once';
  const g = grantFromAnswer({
    ...(ask.command !== undefined
      ? once
        ? { command: ask.command, match: 'exact' as const }
        : commandGrantScope(ask.command)
      : { path: ask.path! }),
    mode: once ? 'once' : 'always',
    harness: ask.harness,
    dispatch: decision.dispatch,
    ...(once && ask.trap ? { trap: ask.trap } : {}),
  });
  sendMessage(
    decision.dispatch,
    lane,
    `Chris allowed ${target} ${once ? 'once' : `always (${what(g)})`} ${where}: grant ${g.id}. ` +
      '`lobstah grants` shows it. ' +
      (ask.command !== undefined
        ? `Run the command again exactly as shown, with nothing added before or after it: ${ask.command}`
        : `Make the write to ${ask.path} again.`),
    'glass',
  );
  return g;
}

/**
 * `man roster set --config key=value ...` as a profile patch (`key=` clears
 * the key). Saving bypass (`permissionMode=bypass`, `bypassPermissions`, or
 * `bypass=true`) is a person's choice at a terminal, as for `trap bypass`:
 * it refuses in an agent session, the helm's too. Clearing it is anyone's.
 */
export function rosterConfigPatch(
  pairs: string[],
  env: NodeJS.ProcessEnv = process.env,
  tty?: boolean,
): { config: Record<string, string | null>; bypass: boolean } {
  const config: Record<string, string | null> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new GrantError(`--config takes key=value (key= clears the key): ${pair}`);
    config[pair.slice(0, eq)] = pair.slice(eq + 1) || null;
  }
  if (config.permissionMode === 'bypass') config.permissionMode = 'bypassPermissions';
  const bypass =
    config.permissionMode === 'bypassPermissions' || (config.bypass !== undefined && config.bypass !== null && config.bypass !== 'false');
  if (bypass) personOnly('man roster set --config permissionMode=bypass', env, tty);
  return { config, bypass };
}

/** The warning a bypass trap carries, in one line. */
export const BYPASS_WARNING =
  'A bypass trap acts as your account with no permission checks: it runs any command and writes any file without asking. Meant for isolated machines.';

/**
 * `lobstah trap bypass <trap> on|off`: from its next start, the trap runs with
 * no permission checks (Claude Code --dangerously-skip-permissions; Codex
 * --dangerously-bypass-approvals-and-sandbox). A person's choice, at a
 * terminal: an agent cannot turn it on for itself.
 */
export function bypassCommand(address: string, on: boolean, yes = false): void {
  if (on) refuseAgentSession('lobstah trap bypass');
  const entry = rosterByAddress(address);
  if (!entry) throw new GrantError(`no roster record for ${address}: a trap joins the roster when it signs on`);
  if (on) {
    console.log(`warning: ${BYPASS_WARNING}`);
    if (!yes && !confirm(`Start ${entry.name} with no permission checks from its next start?`)) {
      console.log('unchanged');
      return;
    }
  }
  setRosterProfile(entry.trapId, { config: { bypass: on ? 'true' : null } });
  console.log(
    toonKV({
      trap: entry.name,
      bypass: on,
      next: on
        ? `lobstah man throw ${entry.name} starts it with no permission checks; a session running now keeps its mode`
        : 'its next start runs with the normal permission checks',
    }),
  );
}

export const TOOL_FAMILY_OPTION = 'Allow this tool family for 15 min';
export const toolFamily = (tool: string): string =>
  tool.startsWith('mcp__') && tool.lastIndexOf('__') > 4 ? `${tool.slice(0, tool.lastIndexOf('__'))}__*` : tool;

export function sessionDuration(raw = '15m'): number {
  const m = /^(\d+)(m|h)$/.exec(raw);
  const ms = m ? Number(m[1]) * (m[2] === 'h' ? 3600_000 : 60_000) : 0;
  if (ms <= 0 || ms > 4 * 3600_000) throw new GrantError('--for must be 1m to 4h');
  return ms;
}

function sessionTarget(opts: { session?: string; trap?: string; grounds?: string }): string {
  if ([opts.session, opts.trap, opts.grounds].filter(Boolean).length !== 1)
    throw new GrantError('choose exactly one --session, --trap, or --grounds');
  const roster = opts.trap ? rosterByAddress(opts.trap) : undefined;
  const session =
    opts.session ??
    (opts.trap
      ? listTraps().find((t) => t.name === opts.trap || t.trapId === roster?.trapId)?.sessionId
      : listHelms().find((h) => h.grounds === opts.grounds)?.sessionId);
  if (!session || !/^[A-Za-z0-9_-]{1,200}$/.test(session)) throw new GrantError('no live session for that target');
  return session;
}

type SessionOptions = {
  session?: string;
  trap?: string;
  grounds?: string;
  tools: string;
  hosts?: string[];
  duration?: string;
  reason: string;
  command?: string;
};

/** Asking is agent-safe: this writes a decision, never a grant. */
export function requestSessionGrant(opts: SessionOptions): DecisionMeta {
  const session = sessionTarget(opts);
  const durationMs = sessionDuration(opts.duration);
  validateSessionGrant({
    mode: 'session',
    session,
    tools: opts.tools,
    hosts: opts.hosts,
    ...(opts.command ? { command: opts.command, match: 'prefix' } : {}),
    by: 'request',
    expiresAt: new Date(Date.now() + durationMs).toISOString(),
  });
  if (!opts.tools || !/^[A-Za-z0-9_.*-]{1,200}$/.test(opts.tools) || !/[A-Za-z0-9]/.test(opts.tools))
    throw new GrantError('an exact tool name or tool glob is required');
  if (opts.tools === 'Bash' && !opts.command) throw new GrantError('Bash session grants require a command prefix');
  if (opts.command && /[;&|<>`$\n\r]/.test(opts.command)) throw new GrantError('a session Bash prefix cannot contain shell syntax');
  if (!opts.reason.trim()) throw new GrantError('--reason is required');
  const duration = opts.duration ?? '15m';
  return askDecision({
    title: `Allow ${opts.tools} for ${duration}?`.slice(0, 200),
    detailText: `Session: \`${session}\`\n\nTools: \`${opts.tools}\`\n\n${opts.command ? `Bash prefix: \`${opts.command}\`\n\n` : ''}Hosts: \`${(opts.hosts ?? []).join(', ') || 'not pinned'}\`\n\n${opts.reason}\n\nExpires automatically. Revoke at any time in the glass. Clicks and screenshots have no URL and ride this window.`,
    options: [...new Set([`Allow for ${duration}`, 'Allow for 1h', 'Deny'])],
    askedBy: 'worker',
    permission: {
      harness: 'any',
      session,
      tool: opts.tools,
      sessionGrant: {
        session,
        tools: opts.tools,
        hosts: opts.hosts,
        durationMs,
        reason: opts.reason,
        ...(opts.command ? { command: opts.command } : {}),
      },
    },
    maxBytes: loadConfig().limits.attachmentMaxBytes,
  }).meta;
}

export function sessionGrantCommand(opts: SessionOptions & { yes?: boolean }): void {
  personOnly('lobstah grant --session');
  const session = sessionTarget(opts);
  const durationMs = sessionDuration(opts.duration);
  if (!opts.yes && !confirm(`Allow ${opts.tools} for session ${session}, for ${opts.duration ?? '15m'}?`)) return;
  const grant = addGrant({
    mode: 'session',
    session,
    tools: opts.tools,
    hosts: opts.hosts,
    reason: opts.reason,
    ...(opts.command ? { command: opts.command, match: 'prefix' } : {}),
    by: localPerson(),
    expiresAt: new Date(Date.now() + durationMs).toISOString(),
  });
  console.log(toonKV({ granted: grant.id, session, tools: grant.tools, expires: grant.expiresAt }));
}
