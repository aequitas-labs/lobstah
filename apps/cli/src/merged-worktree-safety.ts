import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dispatchPrUrls, dispatchWorktree, followUpAncestors, laneDirs, loadConfig, parsePrRef, readEvidence, readPr, readPrs, storedDescriptor } from '@lobstah/core';
import { withRepoLockSync } from '@lobstah/worktree';

const git = (dir: string, ...args: string[]): string | undefined => {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
};

/** A merged PR is evidence of a push, even after a squash merge deletes its branch.
 * Never infer that newer work is published merely because some remote contains it.
 */
export function mergedWorktreeUnsafe(dir: string, heads: readonly string[], trunk: string, fetched: Map<string, boolean>): string | undefined {
  const status = git(dir, 'status', '--porcelain', '--untracked-files=all');
  if (status === undefined) return 'unknown (not a readable git checkout; retry next pass)';
  if (status) return `dirty (${status.split('\n').length} files)`;
  const head = git(dir, 'rev-parse', 'HEAD');
  const recorded = [...new Set(heads.filter((s) => /^[a-f0-9]{40,64}$/i.test(s)))];
  if (head && recorded.includes(head)) return undefined;
  let available = recorded.filter((s) => git(dir, 'cat-file', '-t', s) === 'commit');
  const count = (): number | undefined => {
    const base = git(dir, 'rev-parse', '--verify', `refs/remotes/origin/${trunk}^{commit}`);
    const exclusions = [...available, ...(base ? [base] : [])];
    if (!exclusions.length) return undefined;
    const n = git(dir, 'rev-list', '--count', 'HEAD', '--not', ...exclusions);
    return n === undefined ? undefined : Number(n);
  };
  // Local ancestry already proves that no unpublished commits would be lost.
  if (count() === 0) return undefined;
  const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir') ?? dir;
  if (!fetched.has(common)) fetched.set(common, withRepoLockSync(dir, () => git(dir, 'fetch', '--quiet', 'origin')) !== undefined);
  available = recorded.filter((s) => git(dir, 'cat-file', '-t', s) === 'commit');
  if (count() === 0) return undefined;
  if (!fetched.get(common)) return 'unknown (fetch failed, remote state unknown; retry next pass)';
  const n = count();
  if (n !== undefined && recorded.length > 0 && available.length === recorded.length) return `ahead of PR head (${n} commits)`;
  return 'unknown (recorded PR heads unavailable; retry next pass)';
}

/** The retention/pressure cull must use the same proof as early release, and
 * retain its dispatch/PR records while a checkout is kept for a later retry.
 */
export function mergedCullProofs(): Map<string, { heads: string[]; trunk: string; keys: Set<string>; users: Set<string> }> {
  const proofs = new Map<string, { heads: string[]; trunk: string; keys: Set<string>; users: Set<string> }>();
  const records = readPrs();
  const config = loadConfig();
  for (const lane of ['work', 'chore'] as const) {
    const done = laneDirs(lane).done;
    for (const id of fs.readdirSync(done).filter((s) => !s.startsWith('.'))) {
      const owner = dispatchWorktree(id, lane).owner;
      const ev = readEvidence(id, lane);
      const lineage = new Set([id, ...followUpAncestors(id, lane)]);
      const prs = records.filter((r) => r.dispatches?.some((d) => lineage.has(d)) && (r.dispatches.includes(id) || ev.branch === r.headRefName));
      for (const url of dispatchPrUrls(ev)) {
        const ref = parsePrRef(url);
        if (!ref) continue;
        const r = readPr(ref.key) ?? (ev.pr?.url === url ? { ...ev.pr, key: ref.key, observedHeadShas: [] } : undefined);
        if (r && !prs.some((p) => p.key === r.key)) prs.push(r as (typeof records)[number]);
      }
      const proof = proofs.get(owner) ?? { heads: [], trunk: config.repos[storedDescriptor(id, lane)?.repo ?? '']?.trunk ?? 'main', keys: new Set<string>(), users: new Set<string>() };
      for (const r of prs) {
        if (r.state !== 'MERGED') continue;
        proof.heads.push(...(r.observedHeadShas ?? []), r.headSha);
        proof.keys.add(r.key);
      }
      proof.users.add(id);
      proofs.set(owner, proof);
    }
  }
  return new Map([...proofs].filter(([, p]) => p.keys.size > 0));
}
