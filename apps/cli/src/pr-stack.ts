import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePrRef } from '@lobstah/core';
import type { PrRef } from '@lobstah/core';

/** One subprocess run; tests swap in a fake `git` and `gh`. */
export type StackRun = (cmd: string, args: string[], cwd: string) => { status: number | null; stdout: string };

const defaultRun: StackRun = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: cmd === 'gh' ? 10_000 : 3_000, windowsHide: true });
  return { status: res.error ? null : res.status, stdout: res.stdout ?? '' };
};

/** The most branches the base-chain walk asks `gh` about. */
const MAX_CHAIN_BRANCHES = 12;

/** gh-stack's local state (`<git dir>/gh-stack`, schema 1): the stacks this checkout tracks. */
interface GhStackFile {
  stacks?: Array<{ branches?: Array<{ branch?: string; pullRequest?: { url?: string } }> }>;
}

/** The PRs of the gh stack that holds one of `keys`, bottom to top. Empty when none does. */
function ghStackPrs(cwd: string, keys: Set<string>, run: StackRun): PrRef[] {
  for (const which of ['--git-dir', '--git-common-dir']) {
    const res = run('git', ['rev-parse', which], cwd);
    if (res.status !== 0 || !res.stdout.trim()) continue;
    let state: GhStackFile;
    try {
      state = JSON.parse(fs.readFileSync(path.join(path.resolve(cwd, res.stdout.trim()), 'gh-stack'), 'utf8')) as GhStackFile;
    } catch {
      continue;
    }
    for (const stack of state.stacks ?? []) {
      const refs = (stack.branches ?? []).map((b) => (b.pullRequest?.url ? parsePrRef(b.pullRequest.url) : undefined)).filter((r): r is PrRef => !!r);
      if (refs.some((r) => keys.has(r.key))) return refs;
    }
  }
  return [];
}

interface ChainPr {
  ref: PrRef;
  head: string;
  base: string;
}

/**
 * The PRs linked to a reported PR by base branches, where each PR's head is
 * one of the dispatch's branches: `gh pr view <branch>` for each of them.
 * A dispatch with fewer than two branches asks nothing.
 */
function baseChainPrs(reported: PrRef[], branches: readonly string[], cwd: string, run: StackRun): PrRef[] {
  if (branches.length < 2 || reported.length === 0) return [];
  const repo = `${reported[0]!.owner}/${reported[0]!.repo}`;
  const byHead = new Map<string, ChainPr>();
  for (const branch of branches.slice(0, MAX_CHAIN_BRANCHES)) {
    const res = run('gh', ['pr', 'view', branch, '--repo', repo, '--json', 'url,headRefName,baseRefName'], cwd);
    if (res.status !== 0) continue;
    try {
      const view = JSON.parse(res.stdout) as { url?: string; headRefName?: string; baseRefName?: string };
      const ref = view.url ? parsePrRef(view.url) : undefined;
      if (ref && view.headRefName === branch && view.baseRefName) byHead.set(branch, { ref, head: branch, base: view.baseRefName });
    } catch {
      // Not JSON: no PR for this branch.
    }
  }
  const keys = new Set(reported.map((r) => r.key));
  const seen = new Set<string>();
  const todo = [...byHead.values()].filter((n) => keys.has(n.ref.key));
  const out: ChainPr[] = [];
  while (todo.length > 0) {
    const n = todo.pop()!;
    if (seen.has(n.head)) continue;
    seen.add(n.head);
    out.push(n);
    const below = byHead.get(n.base);
    if (below) todo.push(below);
    for (const above of byHead.values()) if (above.base === n.head) todo.push(above);
  }
  // Bottom to top: a PR whose base is another's head comes after it.
  const heads = new Set(out.map((n) => n.head));
  const ordered: ChainPr[] = [];
  let next = out.find((n) => !heads.has(n.base));
  while (next && !ordered.includes(next)) {
    ordered.push(next);
    const head = next.head;
    next = out.find((n) => n.base === head);
  }
  for (const n of out) if (!ordered.includes(n)) ordered.push(n);
  return ordered.map((n) => n.ref);
}

/**
 * The PRs a `report --pr` records: the reported PRs first, then the other
 * PRs of the gh stack that holds one of them (read from the checkout's
 * gh-stack state), then the other PRs of a base chain of the dispatch's
 * branches. One per PR, canonical URLs. Never throws.
 */
export function stackPrUrls(reported: readonly string[], opts: { cwd: string; branches?: readonly string[]; run?: StackRun }): string[] {
  const run = opts.run ?? defaultRun;
  const refs = reported.map((u) => parsePrRef(u)).filter((r): r is PrRef => !!r);
  const out = new Map<string, string>();
  const add = (r: PrRef) => {
    if (!out.has(r.key)) out.set(r.key, r.url);
  };
  refs.forEach(add);
  if (refs.length === 0) return [];
  try {
    const keys = new Set(refs.map((r) => r.key));
    ghStackPrs(opts.cwd, keys, run).forEach(add);
    baseChainPrs(refs, opts.branches ?? [], opts.cwd, run).forEach(add);
  } catch {
    // A stack that cannot be read adds nothing.
  }
  return [...out.values()];
}
