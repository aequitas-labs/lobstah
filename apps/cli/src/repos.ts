import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { configPath } from '@lobstah/core';

export interface DetectedRepo {
  key: string;
  path: string;
  trunk: string;
  origin?: string;
  setup?: string[];
}

function git(dir: string, ...args: string[]): string | undefined {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

const LOCKFILE_SETUP: Array<[string, string[]]> = [
  ['pnpm-lock.yaml', ['pnpm install']],
  ['package-lock.json', ['npm install']],
  ['yarn.lock', ['yarn install']],
  ['bun.lockb', ['bun install']],
  ['bun.lock', ['bun install']],
  ['uv.lock', ['uv sync']],
  ['poetry.lock', ['poetry install']],
];

/**
 * A folder name as a repo key: characters a bare TOML key cannot hold (a dot
 * would nest the table) become `-`, so `my.repo` is keyed `my-repo`.
 */
export function repoKeyFor(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Read what the repo itself declares: origin, default branch, install step. */
export function detectRepo(dir: string): DetectedRepo | undefined {
  const abs = path.resolve(dir);
  if (git(abs, 'rev-parse', '--is-inside-work-tree') !== 'true') return undefined;
  const top = git(abs, 'rev-parse', '--show-toplevel');
  // git reports the physical path; canonicalize both sides so a symlinked
  // tmpdir, an 8.3 short path, or Windows case differences don't make a repo
  // root look nested. realpathSync.native expands short names; plain
  // realpathSync does not.
  const canon = (p: string) => {
    const real = path.resolve(fs.realpathSync.native(p));
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  if (!top || canon(top) !== canon(abs)) return undefined;
  const origin = git(abs, 'remote', 'get-url', 'origin');
  // origin/HEAD names the forge's default branch. A clone without it tries a
  // main or master branch, origin's then local, before the checked-out branch:
  // a repo scanned while on a feature branch must not get it as trunk.
  const headRef = git(abs, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  const has = (ref: string) => git(abs, 'rev-parse', '--verify', '--quiet', ref) !== undefined;
  const named = ['main', 'master'].find((b) => has(`refs/remotes/origin/${b}`)) ?? ['main', 'master'].find((b) => has(`refs/heads/${b}`));
  const trunk = headRef?.replace(/^origin\//, '') ?? named ?? (git(abs, 'branch', '--show-current') || 'main');
  const setup = LOCKFILE_SETUP.find(([f]) => fs.existsSync(path.join(abs, f)))?.[1];
  return { key: repoKeyFor(path.basename(abs)), path: abs, trunk, origin, setup };
}

/** Git repos directly at or one level under each root — the scan surface. */
export function scanForRepos(roots: string[]): DetectedRepo[] {
  const found: DetectedRepo[] = [];
  for (const root of roots) {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) continue;
    const self = detectRepo(abs);
    if (self) {
      found.push(self);
      continue; // a repo root's children are its own tree, not more repos
    }
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = detectRepo(path.join(abs, entry.name));
      if (child) found.push(child);
    }
  }
  return found;
}

export function configuredRepoKeys(file = configPath()): Set<string> {
  return new Set(configuredRepoPaths(file).keys());
}

/** Configured repo keys, each with its `path` as written. */
export function configuredRepoPaths(file = configPath()): Map<string, string> {
  if (!fs.existsSync(file)) return new Map();
  const raw = parse(fs.readFileSync(file, 'utf8')) as { repos?: Record<string, { path?: unknown }> };
  return new Map(Object.entries(raw.repos ?? {}).map(([key, r]) => [key, String(r?.path ?? '')]));
}

/**
 * Append a [repos.<key>] block as text — the config file is hand-edited and
 * commented, so a parse-and-rewrite would destroy what the user wrote.
 */
export function appendRepoBlock(repo: DetectedRepo, opts: { pickup?: boolean } = {}, file = configPath()): void {
  const header = /^[A-Za-z0-9_-]+$/.test(repo.key) ? repo.key : JSON.stringify(repo.key);
  const lines = [``, `[repos.${header}]`, `path  = ${JSON.stringify(repo.path)}`, `trunk = ${JSON.stringify(repo.trunk)}`];
  if (repo.origin) lines.push(`origin = ${JSON.stringify(repo.origin)}`);
  if (repo.setup) lines.push(`setup  = [${repo.setup.map((s) => JSON.stringify(s)).join(', ')}]`);
  if (opts.pickup) lines.push(`pickup = true`);
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}
