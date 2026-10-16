import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from './config.js';

/**
 * Where an "Allow always" grant applies. Traps work in their own worktrees,
 * so a path or command a person allows always is read relative to the repo
 * it sits in: a write to `apps/x.sh` in one homebase worktree covers
 * `apps/x.sh` in every homebase checkout (the main checkout, trap and pool
 * worktrees, Codex's worktrees: any linked worktree git knows of). A path
 * outside every configured repo is not widened.
 */

/** One checkout of a configured repo. */
export interface CheckoutRoot {
  repo: string;
  root: string;
}

/** Marks a repo root in a stored command: `{repo:homebase}/apps/x.sh`. Not shell syntax, so a prefix grant may hold it. */
const PLACEHOLDER = /\{repo:([A-Za-z0-9_-]+)\}/g;
export const REPO_PLACEHOLDER_OPEN = '{repo:';

const real = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

/** A checkout's git directory shared by all its worktrees, from its `.git` entry. */
function commonDir(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) return dotGit;
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!gitdir) return undefined;
    const own = path.resolve(root, gitdir);
    const common = path.join(own, 'commondir');
    return fs.existsSync(common) ? path.resolve(own, fs.readFileSync(common, 'utf8').trim()) : own;
  } catch {
    return undefined;
  }
}

/** The linked worktrees git records under a common dir: each `worktrees/<name>/gitdir` names `<worktree>/.git`. */
function linkedWorktrees(common: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(common, 'worktrees'));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    try {
      const gitdir = fs.readFileSync(path.join(common, 'worktrees', name, 'gitdir'), 'utf8').trim();
      if (gitdir) out.push(path.dirname(path.resolve(common, 'worktrees', name, gitdir)));
    } catch {
      /* a half-removed worktree */
    }
  }
  return out;
}

/**
 * Every checkout of each configured repo, longest root first so a worktree
 * nested inside a main checkout (`.claude/worktrees/…`) wins over it. A
 * config that does not load gives none: grants then stay exact.
 */
export function checkoutRoots(repos?: Record<string, { path: string }>): CheckoutRoot[] {
  let configured = repos;
  if (!configured) {
    try {
      configured = loadConfig().repos;
    } catch {
      return [];
    }
  }
  const seen = new Set<string>();
  const out: CheckoutRoot[] = [];
  const add = (repo: string, root: string) => {
    for (const r of [path.resolve(root), real(root)]) {
      if (r === path.parse(r).root || seen.has(r)) continue;
      seen.add(r);
      out.push({ repo, root: r });
    }
  };
  for (const [repo, cfg] of Object.entries(configured)) {
    if (!cfg.path) continue;
    const root = path.resolve(cfg.path);
    add(repo, root);
    const common = commonDir(root);
    if (!common) continue;
    if (path.basename(common) === '.git') add(repo, path.dirname(common));
    for (const wt of linkedWorktrees(common)) add(repo, wt);
  }
  return out.sort((a, b) => b.root.length - a.root.length);
}

/** An absolute path with its symlinks resolved as far as it exists, so a link out of a checkout is not read as inside it. */
function canonical(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse());
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.resolve(p);
      tail.push(path.basename(head));
      head = up;
    }
  }
}

/** The repo a path sits in and the path relative to that checkout's root, or nothing outside every checkout. */
export function locateInRepo(p: string, roots: readonly CheckoutRoot[]): { repo: string; rel: string } | undefined {
  const abs = canonical(p);
  const hit = roots.find((r) => abs === r.root || abs.startsWith(r.root + path.sep));
  return hit ? { repo: hit.repo, rel: path.relative(hit.root, abs).split(path.sep).join('/') } : undefined;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A command with each checkout root in it replaced by `{repo:<key>}`, so the
 * same command run from another worktree of that repo reads the same. A root
 * counts only as a whole path: not inside a longer one, not as the start of
 * a sibling (`/repo` in `/repo-old`).
 */
export function normaliseCommand(command: string, roots: readonly CheckoutRoot[]): string {
  if (roots.length === 0) return command;
  const byRoot = new Map(roots.map((r) => [r.root, r.repo]));
  const re = new RegExp(`(?<![\\w./~-])(${roots.map((r) => escapeRe(r.root)).join('|')})(?![\\w.~-])`, 'g');
  return command.replace(re, (root) => `${REPO_PLACEHOLDER_OPEN}${byRoot.get(root)!}}`);
}

/** The repos a normalised command names. */
export function commandRepos(command: string): string[] {
  return [...new Set([...command.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** What an "Allow always" grant stores for a command or a path: repo-relative where it can be. */
export function alwaysScope(
  target: { command: string } | { path: string },
  roots: readonly CheckoutRoot[],
): { command: string; repos: string[] } | { path: string; repo?: string } {
  if ('command' in target) {
    const command = normaliseCommand(target.command, roots);
    return { command, repos: commandRepos(command) };
  }
  const dir = target.path.endsWith('/') || target.path.endsWith(path.sep);
  const at = locateInRepo(target.path, roots);
  if (!at || at.rel === '') return { path: path.resolve(target.path) + (dir ? '/' : '') };
  return { path: at.rel + (dir ? '/' : ''), repo: at.repo };
}
