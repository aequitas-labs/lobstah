import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from './paths.js';

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
 */

export type GrantHarness = 'claude' | 'codex' | 'any';
export type GrantMode = 'once' | 'always';

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
  /** Only this trap may use it, when set. */
  trap?: string;
  /** The dispatch whose request it answered, when it came from a card. */
  dispatch?: string;
  expiresAt?: string;
  uses: number;
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface GrantInput {
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
  command?: string;
  path?: string;
  trap?: string;
}

type LedgerEvent =
  | ({ type: 'grant' } & Omit<Grant, 'uses' | 'lastUsedAt' | 'revokedAt' | 'revokedBy'>)
  | { type: 'use'; id: string; at: string; session?: string }
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
    if (ev.prev !== head) return { grants: [...byId.values()], intact: false, problem: `line ${n + 1} does not follow the line before it`, head };
    head = sha(line);
    if (ev.type === 'grant') {
      const { type: _type, prev: _prev, ...grant } = ev as LedgerEvent & { type: 'grant'; prev?: unknown };
      byId.set(grant.id, { ...grant, uses: 0 });
    } else if (ev.type === 'use') {
      const g = byId.get(ev.id);
      if (g) Object.assign(g, { uses: g.uses + 1, lastUsedAt: ev.at });
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
  const lock = path.join(grantsDir(), 'ledger.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // A holder that died leaves the lock behind; one older than the wait is taken over.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* it went away */
      }
      if (Date.now() > deadline) throw new GrantError('the grants ledger is locked; try again');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
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

function normalisePath(p: string): string {
  const resolved = path.resolve(p);
  return p.endsWith('/') || p.endsWith(path.sep) ? `${resolved}${path.sep}` : resolved;
}

/**
 * Does the grant cover the request? A command grant matches the command
 * exactly, or, as a prefix, the command or the command followed by more
 * arguments; a prefix never covers anything joined on with shell syntax
 * (`;`, `&&`, `|`, a redirect, a subshell), so `wrangler deploy` does not
 * cover `wrangler deploy; curl …`. A path grant covers the write tools on
 * that file, or on anything under it when it ends in a slash.
 */
export function grantCovers(g: Grant, req: GrantRequest): boolean {
  if (g.harness !== 'any' && g.harness !== req.harness) return false;
  if (g.trap && g.trap !== req.trap) return false;
  if (g.command !== undefined) {
    const cmd = req.command?.trim();
    if (!cmd) return false;
    const want = g.command.trim();
    if (cmd === want) return true;
    if (g.match !== 'prefix' || !cmd.startsWith(`${want} `)) return false;
    return !SHELL_JOINERS.test(cmd.slice(want.length));
  }
  if (g.path !== undefined) {
    if (!(WRITE_TOOLS as readonly string[]).includes(req.tool) || !req.path) return false;
    const want = normalisePath(g.path);
    const have = normalisePath(req.path);
    return want.endsWith(path.sep) ? have.startsWith(want) : have === want;
  }
  return false;
}

/** The grants in force, newest first; with `all`, every grant ever made. */
export function listGrants(opts: { all?: boolean; now?: number } = {}): { grants: Grant[]; intact: boolean; problem?: string } {
  const ledger = readLedger();
  const grants = ledger.grants.filter((g) => opts.all || grantActive(g, opts.now)).sort((a, b) => b.at.localeCompare(a.at));
  return { grants, intact: ledger.intact, ...(ledger.problem ? { problem: ledger.problem } : {}) };
}

/** Record a grant a person made. */
export function addGrant(input: GrantInput, now = new Date()): Grant {
  const command = input.command?.trim();
  const target = input.path?.trim();
  if (!command === !target) throw new GrantError('a grant names one command or one path');
  if (command && input.match === 'prefix' && SHELL_JOINERS.test(command)) {
    throw new GrantError('a prefix grant cannot contain shell syntax (;, &, |, a redirect or a subshell); grant the exact command instead');
  }
  if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) throw new GrantError(`invalid expiry ${input.expiresAt}`);
  const expiresAt = input.expiresAt ?? (input.mode === 'once' ? new Date(now.getTime() + ONCE_TTL_MS).toISOString() : undefined);
  const grant: Grant = {
    id: `g-${crypto.randomBytes(4).toString('hex')}`,
    at: now.toISOString(),
    by: input.by,
    harness: input.harness ?? 'any',
    mode: input.mode,
    ...(command ? { command, match: input.match ?? 'exact' } : { path: path.resolve(target!) + (target!.endsWith('/') ? '/' : '') }),
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
export function useGrant(req: GrantRequest, opts: { session?: string; now?: Date } = {}): Grant | undefined {
  const now = opts.now ?? new Date();
  if (!fs.existsSync(ledgerPath())) return undefined;
  return withLock(() => {
    const ledger = readLedger();
    if (!ledger.intact) return undefined;
    // Prefer an always-grant, so a once-grant is not spent where an always-grant would do.
    const covering = ledger.grants
      .filter((g) => grantActive(g, now.getTime()) && grantCovers(g, req))
      .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'always' ? -1 : 1));
    const g = covering[0];
    if (!g) return undefined;
    append(ledger.head, { type: 'use', id: g.id, at: now.toISOString(), ...(opts.session ? { session: opts.session } : {}) });
    return { ...g, uses: g.uses + 1, lastUsedAt: now.toISOString() };
  });
}
