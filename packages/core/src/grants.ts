import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from './paths.js';
import { withDirLock } from './dir-lock.js';
import { REPO_PLACEHOLDER_OPEN, alwaysScope, checkoutRoots, locateInRepo, normaliseCommand } from './grant-scope.js';
import type { CheckoutRoot } from './grant-scope.js';

/**
 * Grants: approvals a person makes once, centrally, that a trap's harness
 * honours without anyone opening the trap's chat. A grant names one shell
 * command (exactly, or as a prefix) or one file path for a write tool, the
 * harness it applies to, and whether it is good once or always.
 *
 * The ledger is `grants/ledger.jsonl`: an append-only list of events
 * (grant, use, revoke), each line naming the hash of the line before it,
 * and `grants/head` the hash of the last. An edited or removed line breaks
 * the chain, and a broken ledger grants nothing until it is repaired. This
 * shows tampering; it cannot stop a process running as the same user, which
 * is why grants are honoured only through the harness hooks and the
 * harnesses' own checks stand between an agent and these files. Grants are written only by a person: a
 * glass answer, or `lobstah grant` at a terminal. The harness hooks read it
 * and record each use.
 *
 * An always-grant follows the repo, not one worktree (see grant-scope.ts):
 * its path is stored relative to the repo root with the repo's key, and the
 * checkout roots in its command as `{repo:<key>}`. Older always-grants,
 * stored absolute, are read the same way when they sit inside a checkout.
 * A once-grant stays exact.
 */

export type GrantHarness = 'claude' | 'codex' | 'any';
export type GrantMode = 'once' | 'always' | 'session';

/** An unused once-grant lapses after this long unless an expiry is given. */
export const ONCE_TTL_MS = 60 * 60 * 1000;

/** The file tools a path grant covers. */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'] as const;

export interface Grant {
  id: string;
  at: string;
  /** Who granted it: `glass`, or `local:<user>` for the CLI. */
  by: string;
  harness: GrantHarness;
  mode: GrantMode;
  /** A shell command grant: the command, matched exactly or as a prefix. */
  command?: string;
  match?: 'exact' | 'prefix';
  /** A file grant: a path for the write tools; a trailing slash covers everything under it. */
  path?: string;
  /** Set on an always path grant inside a repo: `path` is relative to that repo's root, in any of its checkouts. */
  repo?: string;
  /** Only this trap may use it, when set. */
  trap?: string;
  /** The dispatch whose request it answered, when it came from a card. */
  dispatch?: string;
  expiresAt?: string;
  session?: string;
  tools?: string;
  hosts?: string[];
  reason?: string;
  audit?: Array<{ tool: string; at: string; hosts?: string[] }>;
  callIds?: string[];
  uses: number;
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface GrantInput {
  session?: string;
  tools?: string;
  hosts?: string[];
  reason?: string;
  command?: string;
  match?: 'exact' | 'prefix';
  path?: string;
  mode: GrantMode;
  harness?: GrantHarness;
  by: string;
  trap?: string;
  dispatch?: string;
  expiresAt?: string;
}

/** What a harness is about to do, as a hook sees it. */
export interface GrantRequest {
  harness: 'claude' | 'codex';
  tool: string;
  session?: string;
  input?: Record<string, unknown>;
  cwd?: string;
  command?: string;
  path?: string;
  trap?: string;
}

type LedgerEvent =
  | ({ type: 'grant' } & Omit<Grant, 'uses' | 'lastUsedAt' | 'revokedAt' | 'revokedBy'>)
  | { type: 'use'; id: string; at: string; session?: string; tool?: string; hosts?: string[]; callId?: string }
  | { type: 'revoke'; id: string; at: string; by: string };

export class GrantError extends Error {}

export function grantsDir(): string {
  return path.join(lobstahHome(), 'grants');
}

function ledgerPath(): string {
  return path.join(grantsDir(), 'ledger.jsonl');
}

function headPath(): string {
  return path.join(grantsDir(), 'head');
}

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

export interface Ledger {
  grants: Grant[];
  /** False when the chain is broken: then no grant is honoured. */
  intact: boolean;
  problem?: string;
  /** The hash the next line must name. */
  head: string;
}

/** Read the ledger and fold its events into grants, checking the chain as it goes. */
export function readLedger(): Ledger {
  let text = '';
  try {
    text = fs.readFileSync(ledgerPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { grants: [], intact: true, head: '' };
    throw err;
  }
  const byId = new Map<string, Grant>();
  let head = '';
  const lines = text.split('\n').filter((l) => l.length > 0);
  for (const [n, line] of lines.entries()) {
    let ev: LedgerEvent & { prev?: unknown };
    try {
      ev = JSON.parse(line) as LedgerEvent & { prev?: unknown };
    } catch {
      return { grants: [...byId.values()], intact: false, problem: `line ${n + 1} is not JSON`, head };
    }
    if (ev.prev !== head)
      return { grants: [...byId.values()], intact: false, problem: `line ${n + 1} does not follow the line before it`, head };
    head = sha(line);
    if (ev.type === 'grant') {
      const { type: _type, prev: _prev, ...grant } = ev as LedgerEvent & { type: 'grant'; prev?: unknown };
      byId.set(grant.id, { ...grant, uses: 0 });
    } else if (ev.type === 'use') {
      const g = byId.get(ev.id);
      if (g) {
        Object.assign(g, { uses: g.uses + 1, lastUsedAt: ev.at });
        if (ev.tool)
          g.audit = [...(g.audit ?? []), { tool: ev.tool, at: ev.at, ...(ev.hosts?.length ? { hosts: ev.hosts } : {}) }].slice(-20);
        if (ev.callId) g.callIds = [...(g.callIds ?? []), ev.callId].slice(-50);
      }
    } else if (ev.type === 'revoke') {
      const g = byId.get(ev.id);
      if (g && !g.revokedAt) Object.assign(g, { revokedAt: ev.at, revokedBy: ev.by });
    }
  }
  let recorded = '';
  try {
    recorded = fs.readFileSync(headPath(), 'utf8').trim();
  } catch {
    /* missing: checked below */
  }
  if (recorded !== head) return { grants: [...byId.values()], intact: false, problem: 'the last line is not the one last written', head };
  return { grants: [...byId.values()], intact: true, head };
}

/** Run `fn` holding the ledger's lock, so two hooks never spend one once-grant. */
function withLock<T>(fn: () => T): T {
  fs.mkdirSync(grantsDir(), { recursive: true, mode: 0o700 });
  // A holder that died leaves the lock behind; one older than the wait is taken over.
  return withDirLock(path.join(grantsDir(), 'ledger.lock'), fn, {
    staleMs: 5000,
    waitMs: 5000,
    pauseMs: 20,
    busy: () => new GrantError('the grants ledger is locked; try again'),
  });
}

function append(head: string, ev: LedgerEvent): void {
  const line = JSON.stringify({ ...ev, prev: head });
  fs.appendFileSync(ledgerPath(), `${line}\n`, { mode: 0o600 });
  const tmp = `${headPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${sha(line)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, headPath());
}

/** True while a grant can still be used. */
export function grantActive(g: Grant, now = Date.now()): boolean {
  if (g.revokedAt) return false;
  if (g.mode === 'once' && g.uses > 0) return false;
  if (g.expiresAt && Date.parse(g.expiresAt) <= now) return false;
  return true;
}

/** Shell syntax that runs a second command or redirects output. */
const SHELL_JOINERS = /[;&|`\n\r<>]|\$\(/;

/** A useful card scope for recognised CLIs; shells, scripts and ambiguous syntax stay exact. */
export function commandGrantScope(raw: string): { command: string; match: 'exact' | 'prefix' } {
  const command = raw.trim();
  const exact = { command, match: 'exact' as const };
  if (SHELL_JOINERS.test(command)) return exact;
  const words = command.split(/\s+/);
  if (
    words[0] === 'lobstah' &&
    (['grant', 'permissions'].includes(words[1] ?? '') || (words[1] === 'trap' && ['grant', 'bypass'].includes(words[2] ?? '')))
  )
    return exact;
  let count = 2;
  if (words[0] === 'npx' || words[0] === 'pnpx') {
    if (!['wrangler', 'vitest', 'playwright', 'tsc'].includes(words[1] ?? '')) return exact;
    count = words[1] === 'tsc' ? 2 : 3;
  } else if (!['ume', 'git', 'pnpm', 'npm', 'yarn', 'bun', 'wrangler', 'gh', 'lobstah'].includes(words[0]!)) return exact;
  if ((words[0] === 'pnpm' || words[0] === 'npm' || words[0] === 'bun') && ['run', 'exec', 'dlx'].includes(words[1] ?? '')) count = 3;
  if ((words[0] === 'git' && ['remote', 'worktree', 'submodule', 'stash'].includes(words[1] ?? '')) || words[0] === 'gh') count = 3;
  if (words[0] === 'ume' && ['intents', 'work', 'theme', 'sdk', 'hooks', 'local', 'skill', 'agent'].includes(words[1] ?? '')) count = 3;
  if (
    ['exec', 'dlx'].includes(words[1] ?? '') &&
    ['node', 'python', 'python3', 'sh', 'bash', 'zsh', 'ruby', 'perl', 'deno', 'tsx', 'ts-node'].includes(words[2] ?? '')
  )
    return exact;
  if (words.length < count || words.slice(0, count).some((w) => !/^[A-Za-z0-9_.-]+$/.test(w) || w.startsWith('-'))) return exact;
  // A dry run must never become permission to perform the operation for real.
  if (words.includes('--dry-run')) {
    if (words[count] !== '--dry-run') return exact;
    count++;
  }
  const prefix = words.slice(0, count).join(' ');
  // Prefix matching is literal: don't propose a scope that cannot cover this call.
  if (command !== prefix && !command.startsWith(`${prefix} `)) return exact;
  return { command: prefix, match: 'prefix' };
}

function normalisePath(p: string): string {
  const resolved = path.resolve(p);
  return p.endsWith('/') || p.endsWith(path.sep) ? `${resolved}${path.sep}` : resolved;
}

/** A file path against a wanted one: the same file, or under it when the wanted one ends in a slash. */
function pathCovers(want: string, have: string, sep: string): boolean {
  return want.endsWith(sep) ? have.startsWith(want) : have === want;
}

/**
 * Does the grant cover the request? A command grant matches the command
 * exactly, or, as a prefix, the command or the command followed by more
 * arguments; a prefix never covers anything joined on with shell syntax
 * (`;`, `&&`, `|`, a redirect, a subshell), so `wrangler deploy` does not
 * cover `wrangler deploy; curl …`. A path grant covers the write tools on
 * that file, or on anything under it when it ends in a slash.
 *
 * An always-grant reads both sides with checkout roots made repo-relative,
 * so it covers the same command or file in any checkout of the repo.
 */
export function grantCovers(g: Grant, req: GrantRequest, roots: readonly CheckoutRoot[] = checkoutRoots()): boolean {
  if (g.mode === 'session') return sessionGrantCovers(g, req);
  if (req.session) return false;
  if (req.session && g.session && req.session !== g.session) return false;
  if (g.harness !== 'any' && g.harness !== req.harness) return false;
  if (g.trap && g.trap !== req.trap) return false;
  const widen = g.mode === 'always';
  if (g.command !== undefined) {
    let cmd = req.command?.trim();
    if (!cmd) return false;
    let want = g.command.trim();
    if (widen) {
      // The placeholder is the grant's own notation; a command that spells it out is not the granted one.
      if (cmd.includes(REPO_PLACEHOLDER_OPEN)) return false;
      cmd = normaliseCommand(cmd, roots);
      want = normaliseCommand(want, roots);
    }
    if (cmd === want) return true;
    if (g.match !== 'prefix' || !cmd.startsWith(`${want} `)) return false;
    const rest = cmd.slice(want.length);
    // Boolean flag parsers may let a later flag negate the granted dry run.
    if (/(?:^|\s)--dry-run(?:\s|$)/.test(want) && /--(?:no-?)?dry[-_]?run\b/i.test(rest)) return false;
    return !SHELL_JOINERS.test(rest);
  }
  if (g.path !== undefined) {
    if (!(WRITE_TOOLS as readonly string[]).includes(req.tool) || !req.path) return false;
    if (widen) {
      const dir = g.path.endsWith('/') || g.path.endsWith(path.sep);
      // A legacy always-grant names an absolute path: read it as repo-relative when it sits in a checkout.
      const scope =
        g.repo !== undefined
          ? { repo: g.repo, rel: g.path.replace(/\/$/, '') }
          : path.isAbsolute(g.path)
            ? locateInRepo(g.path, roots)
            : undefined;
      if (scope && scope.rel !== '') {
        const at = locateInRepo(req.path, roots);
        if (!at || at.repo !== scope.repo) return false;
        return pathCovers(scope.rel + (dir ? '/' : ''), at.rel, '/');
      }
      if (g.repo !== undefined) return false;
    }
    return pathCovers(normalisePath(g.path), normalisePath(req.path), path.sep);
  }
  return false;
}

/** The grants in force, newest first; with `all`, every grant ever made. */
export function listGrants(opts: { all?: boolean; now?: number } = {}): { grants: Grant[]; intact: boolean; problem?: string } {
  const ledger = readLedger();
  const grants = ledger.grants.filter((g) => opts.all || grantActive(g, opts.now)).sort((a, b) => b.at.localeCompare(a.at));
  return { grants, intact: ledger.intact, ...(ledger.problem ? { problem: ledger.problem } : {}) };
}

/**
 * Record a grant a person made. An always-grant is stored repo-relative
 * where it can be: a path inside a checkout as the path from its root plus
 * the repo's key, checkout roots in a command as `{repo:<key>}`.
 */
export function addGrant(input: GrantInput, now = new Date(), roots: readonly CheckoutRoot[] = checkoutRoots()): Grant {
  const command = input.command?.trim();
  const target = input.path?.trim();
  if (input.mode === 'session') {
    const { expiresAt, hosts } = validateSessionGrant(input, now);
    const tool = input.tools!;
    const grant: Grant = {
      id: `g-${crypto.randomBytes(4).toString('hex')}`,
      at: now.toISOString(),
      by: input.by,
      harness: input.harness ?? 'any',
      mode: 'session',
      session: input.session,
      tools: tool,
      ...(command ? { command, match: 'prefix' } : {}),
      ...(hosts.length ? { hosts: [...new Set(hosts)] } : {}),
      ...(input.reason ? { reason: input.reason.slice(0, 1000) } : {}),
      ...(input.trap ? { trap: input.trap } : {}),
      expiresAt,
      uses: 0,
    };
    return withLock(() => {
      const ledger = readLedger();
      if (!ledger.intact) throw new GrantError('the grants ledger is damaged');
      const { uses: _u, ...rest } = grant;
      append(ledger.head, { type: 'grant', ...rest });
      return grant;
    });
  }
  if (!command === !target) throw new GrantError('a grant names one command or one path');
  if (command && input.match === 'prefix' && SHELL_JOINERS.test(command)) {
    throw new GrantError('a prefix grant cannot contain shell syntax (;, &, |, a redirect or a subshell); grant the exact command instead');
  }
  if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) throw new GrantError(`invalid expiry ${input.expiresAt}`);
  const expiresAt = input.expiresAt ?? (input.mode === 'once' ? new Date(now.getTime() + ONCE_TTL_MS).toISOString() : undefined);
  const exactPath = target ? path.resolve(target) + (target.endsWith('/') ? '/' : '') : undefined;
  let what: Pick<Grant, 'command' | 'match' | 'path' | 'repo'>;
  if (command) {
    what = { command: input.mode === 'always' ? normaliseCommand(command, roots) : command, match: input.match ?? 'exact' };
  } else if (input.mode === 'always') {
    const scoped = alwaysScope({ path: target! }, roots) as { path: string; repo?: string };
    what = { path: scoped.path, ...(scoped.repo ? { repo: scoped.repo } : {}) };
  } else {
    what = { path: exactPath! };
  }
  const grant: Grant = {
    id: `g-${crypto.randomBytes(4).toString('hex')}`,
    at: now.toISOString(),
    by: input.by,
    harness: input.harness ?? 'any',
    mode: input.mode,
    ...what,
    ...(input.trap ? { trap: input.trap } : {}),
    ...(input.dispatch ? { dispatch: input.dispatch } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    uses: 0,
  };
  return withLock(() => {
    const ledger = readLedger();
    if (!ledger.intact) throw new GrantError(`the grants ledger is damaged (${ledger.problem}); nothing was written`);
    const { uses: _uses, ...rest } = grant;
    append(ledger.head, { type: 'grant', ...rest });
    return grant;
  });
}

/** Revoke a grant. Anyone may take a permission away. */
export function revokeGrant(id: string, by: string, now = new Date()): Grant {
  return withLock(() => {
    const ledger = readLedger();
    if (!ledger.intact) throw new GrantError(`the grants ledger is damaged (${ledger.problem}); nothing was written`);
    const g = ledger.grants.find((x) => x.id === id);
    if (!g) throw new GrantError(`no grant ${id}`);
    if (g.revokedAt) throw new GrantError(`grant ${id} was already revoked at ${g.revokedAt}`);
    append(ledger.head, { type: 'revoke', id, at: now.toISOString(), by });
    return { ...g, revokedAt: now.toISOString(), revokedBy: by };
  });
}

/**
 * Find a grant in force that covers the request and record its use. A
 * once-grant is spent by it. Returns undefined when nothing covers it, or
 * when the ledger is damaged.
 */
export function useGrant(req: GrantRequest, opts: { session?: string; now?: Date; callId?: string } = {}): Grant | undefined {
  const now = opts.now ?? new Date();
  if (!fs.existsSync(ledgerPath())) return undefined;
  const roots = checkoutRoots();
  return withLock(() => {
    const ledger = readLedger();
    if (!ledger.intact) return undefined;
    // Prefer an always-grant, so a once-grant is not spent where an always-grant would do.
    const covering = ledger.grants
      .filter((g) => grantActive(g, now.getTime()) && grantCovers(g, req, roots))
      .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'always' ? -1 : 1));
    const g = covering[0];
    if (!g) return undefined;
    if (opts.callId && g.callIds?.includes(opts.callId)) return g;
    append(ledger.head, {
      type: 'use',
      id: g.id,
      at: now.toISOString(),
      ...(opts.session ? { session: opts.session } : {}),
      ...(g.mode === 'session'
        ? { tool: req.tool, hosts: toolHosts(req.input ?? {}).hosts, ...(opts.callId ? { callId: opts.callId } : {}) }
        : {}),
    });
    return { ...g, uses: g.uses + 1, lastUsedAt: now.toISOString() };
  });
}

/** URL hosts only: never retain typed text, paths, queries, or other tool inputs. */
export function toolHosts(input: Record<string, unknown>): { hosts: string[]; invalid: boolean } {
  const hosts = new Set<string>();
  let invalid = false;
  let count = 0;
  const walk = (value: unknown, key = '', depth = 0): void => {
    if (++count > 10000 || depth > 20) {
      invalid = true;
      return;
    }
    if (typeof value === 'string') {
      if (/^(?:https?|file|ftp):\/\//i.test(value) || /^(?:url|uri)$/i.test(key)) {
        try {
          const u = new URL(value);
          if (!['http:', 'https:'].includes(u.protocol)) invalid = true;
          else hosts.add(u.hostname.toLowerCase().replace(/\.$/, ''));
        } catch {
          invalid = true;
        }
      }
    } else if (Array.isArray(value)) value.forEach((x) => walk(x, key, depth + 1));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k, depth + 1));
  };
  walk(input);
  return { hosts: [...hosts], invalid };
}

/** Literal sensitive targets are never covered, even by a broad session tool glob. */
export function sessionGuarded(req: GrantRequest): boolean {
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(req.input ?? {});
  if (req.command) strings.push(req.command);
  if (req.path) strings.push(req.path);
  const text = strings.join('\n').replace(/\\/g, '/');
  if (/\blobstah\b[^\n;|&]*\bgrants?\b/i.test(text)) return true;
  const protectedText =
    /(?:^|[/\s'"~])\.(?:claude|codex)\/(?:settings(?:\.local)?\.json|config\.toml|hooks(?:\.json|\/)|rules\/)|\.lobstah\/(?:grants(?:\/|$)|config\.toml)/i;
  if (protectedText.test(text) || text.includes(grantsDir()) || text.includes(path.join(lobstahHome(), 'config.toml'))) return true;
  if (req.cwd && path.resolve(req.cwd) === path.resolve(lobstahHome()) && /\bconfig\.toml\b/.test(text)) return true;
  if (/mcp__lobstah__.*(?:grant|config)/i.test(req.tool)) return true;
  {
    const real = (p: string) => {
      let head = path.resolve(p);
      const tail: string[] = [];
      while (!fs.existsSync(head) && path.dirname(head) !== head) {
        tail.unshift(path.basename(head));
        head = path.dirname(head);
      }
      try {
        return path.join(fs.realpathSync(head), ...tail);
      } catch {
        return path.resolve(p);
      }
    };
    const settingsRoots = [
      process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? '', '.claude'),
      process.env.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex'),
    ]
      .filter(Boolean)
      .map(real);
    const settingsNames = ['settings.json', 'settings.local.json', 'config.toml', 'hooks.json', 'hooks', 'rules'];
    // Relative paths resolve in the caller's cwd; symlink targets count too.
    for (const raw of [
      ...strings.filter((v) => !v.includes('\n')),
      ...strings.flatMap((v) => v.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''))),
    ]) {
      if (!raw.trim()) continue;
      let file = path.resolve(req.cwd ?? process.cwd(), raw.replace(/^~(?=\/)/, process.env.HOME ?? ''));
      let head = file;
      const tail: string[] = [];
      while (!fs.existsSync(head) && path.dirname(head) !== head) {
        tail.unshift(path.basename(head));
        head = path.dirname(head);
      }
      try {
        file = path.join(fs.realpathSync(head), ...tail);
      } catch {
        /* use absolute path */
      }
      if (
        settingsRoots.some(
          (root) =>
            file === root ||
            settingsNames.some((name) => file === path.join(root, name) || file.startsWith(path.join(root, name) + path.sep)),
        )
      )
        return true;
      if (
        file === real(lobstahHome()) ||
        file.startsWith(real(grantsDir()) + path.sep) ||
        file === path.join(real(lobstahHome()), 'config.toml') ||
        /[/]\.(?:claude|codex)[/](?:settings(?:\.local)?\.json|config\.toml|hooks(?:\.json|[/])|rules[/])/.test(file)
      )
        return true;
    }
  }
  return false;
}

export function sessionGrantCovers(g: Grant, req: GrantRequest): boolean {
  if (!req.session || req.session !== g.session || !g.expiresAt || !grantActive(g)) return false;
  if (g.harness !== 'any' && g.harness !== req.harness) return false;
  if (!g.tools || sessionGuarded(req)) return false;
  const pattern = g.tools
    .split('*')
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  if (!new RegExp(`^${pattern}$`).test(req.tool)) return false;
  if (['Bash', 'shell', 'exec_command'].includes(req.tool.split('.').at(-1)!)) {
    if (g.tools !== 'Bash' || !g.command || !req.command) return false;
    return grantCovers({ ...g, mode: 'once', session: undefined, trap: undefined }, { ...req, session: undefined }, []);
  }
  const urls = toolHosts(req.input ?? {});
  if (
    g.hosts?.length &&
    (urls.invalid || urls.hosts.some((h) => !g.hosts!.includes(h)) || (/navigate|WebFetch/i.test(req.tool) && !urls.hosts.length))
  )
    return false;
  return true;
}

/** Validate a request without writing any grant or ledger entry. */
export function validateSessionGrant(input: GrantInput, now = new Date()): { expiresAt: string; hosts: string[] } {
  const command = input.command?.trim();
  const target = input.path?.trim();
  if (!input.session || !/^[A-Za-z0-9_-]{1,200}$/.test(input.session)) throw new GrantError('a session grant needs exactly one session id');
  if (!input.tools || !/^[A-Za-z0-9_.*-]{1,200}$/.test(input.tools) || !/[A-Za-z0-9]/.test(input.tools))
    throw new GrantError('an exact tool name or tool glob is required');
  if (target) throw new GrantError('a session grant cannot name a file');
  const tool = input.tools;
  if ((tool === 'Bash' || /(?:^|[.*_])(Bash|shell|exec_command)(?:$|[.*_])/.test(tool)) && (!command || input.match !== 'prefix'))
    throw new GrantError('Bash session grants require a command prefix');
  if (command && (tool !== 'Bash' || input.match !== 'prefix' || SHELL_JOINERS.test(command)))
    throw new GrantError('a session Bash prefix cannot contain shell syntax');
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + 15 * 60_000).toISOString();
  const ttl = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 4 * 3600_000) throw new GrantError('session grants expire after at most 4h');
  const hosts = (input.hosts ?? []).map((h) => h.trim().toLowerCase().replace(/\.$/, ''));
  if (hosts.some((h) => !h || h.includes('*') || new URL(`https://${h}`).hostname !== h || /[/:@?#]/.test(h)))
    throw new GrantError('hosts must be exact hostnames without URL paths or wildcards');
  return { expiresAt, hosts };
}
