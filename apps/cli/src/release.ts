import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  dispatchPrUrls,
  dispatchWorktree,
  laneDirs,
  loadConfig,
  mergeEvidence,
  parsePrRef,
  readEvidence,
  readKeptWorktrees,
  readPr,
  readPrs,
  readStatusLog,
  storedDescriptor,
  worktreePath,
  worktreesDir,
  writeKeptWorktrees,
} from '@lobstah/core';
import type { Evidence, KeptWorktree, Lane } from '@lobstah/core';
import { withRepoLockSync } from '@lobstah/worktree';
import { applyCull, trapWorktreeIds, worktreeUsage } from './cull.js';
import type { CullItem } from './cull.js';

/**
 * `[limits].releaseOnMerge`: once a PR watch records a merge, the daemon's
 * cull pass removes the worktree of the dispatch that owns the PR and of
 * every dispatch in its follow-up chain that ran on that PR, through the
 * same removal path as the retention cull. Branches, done entries, state,
 * and evidence stay; only the worktree goes.
 *
 * Nothing is released unless every check holds: every dispatch in the chain
 * and every user of the worktree is finished (done or failed); the worktree
 * is clean; and, after a fetch, its HEAD is on the remote. A worktree that
 * fails a check is kept, with the reason recorded for `lobstah doctor`.
 * A PR closed without merge releases nothing. A trap's worktree is never
 * touched.
 */

const DAY = 86_400_000;

interface Known {
  id: string;
  lane: Lane;
  bucket: 'queue' | 'active' | 'done';
}

function listIds(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

function allDispatches(): Map<string, Known> {
  const out = new Map<string, Known>();
  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    for (const id of listIds(d.queue)) out.set(id, { id, lane, bucket: 'queue' });
    for (const id of listIds(d.active)) out.set(id, { id, lane, bucket: 'active' });
    for (const id of listIds(d.done)) out.set(id, { id, lane, bucket: 'done' });
  }
  return out;
}

/** Follow-up chains: every dispatch id mapped to the ids linked to it by followUp, either way. */
function chainComponents(all: Map<string, Known>): Map<string, Set<string>> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const k of all.values()) {
    if (!parent.has(k.id)) parent.set(k.id, k.id);
    const up = storedDescriptor(k.id, k.lane)?.followUp;
    if (!up) continue;
    if (!parent.has(up)) parent.set(up, up);
    parent.set(find(k.id), find(up));
  }
  const groups = new Map<string, Set<string>>();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r)!.add(id);
  }
  const out = new Map<string, Set<string>>();
  for (const g of groups.values()) for (const id of g) out.set(id, g);
  return out;
}

function finished(k: Known | undefined): boolean {
  if (!k) return true; // culled already: nothing runs
  if (k.bucket !== 'done') return false;
  const verb = readStatusLog(k.id, k.lane).at(-1)?.verb;
  return verb === 'done' || verb === 'failed' || verb === undefined;
}

function prUrlOf(ev: Evidence): string | undefined {
  return ev.pr?.url ?? ev.prUrl;
}

/** A merged PR and the dispatches that own it. */
interface MergedPr {
  url: string;
  key: string;
  headRef?: string;
  owners: Set<string>;
}

function mergedPrs(all: Map<string, Known>): Map<string, MergedPr> {
  const merged = new Map<string, MergedPr>();
  const add = (url: string, key: string, headRef: string | undefined, id: string) => {
    const m = merged.get(key) ?? { url, key, headRef, owners: new Set<string>() };
    m.headRef ??= headRef;
    m.owners.add(id);
    merged.set(key, m);
  };
  for (const r of readPrs()) {
    if (r.state !== 'MERGED') continue;
    for (const id of r.dispatches ?? []) if (all.has(id)) add(r.url, r.key, r.headRefName, id);
  }
  for (const k of all.values()) {
    if (k.bucket !== 'done') continue;
    const ev = readEvidence(k.id, k.lane);
    const url = prUrlOf(ev);
    const ref = url ? parsePrRef(url) : undefined;
    if (!ref) continue;
    const record = readPr(ref.key);
    // The record wins when both exist: it is the newer observation.
    const state = record?.state ?? ev.pr?.state;
    if (state === 'MERGED') add(ref.url, ref.key, record?.headRefName ?? ev.pr?.headRefName, k.id);
  }
  return merged;
}

export interface ReleasePlan {
  /** Worktrees to remove now (kind 'worktree', id = the owner id). */
  items: CullItem[];
  /** Per released owner: the dispatches whose evidence records the release. */
  users: Map<string, Known[]>;
  /** Merged-PR worktrees kept, with why. */
  kept: KeptWorktree[];
}

/** git in a worktree; undefined when git fails. */
function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
}

/** Why a worktree must be kept, or undefined when it is safe to remove. */
function unsafe(dir: string, fetched: Map<string, boolean>): string | undefined {
  const status = git(dir, 'status', '--porcelain');
  if (status === undefined) return 'unpushed work: not a readable git checkout';
  if (status !== '') return 'unpushed work: uncommitted changes';
  const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir') ?? dir;
  // The fetch takes turns with runner allocations in the same repo (#127).
  if (!fetched.has(common)) fetched.set(common, withRepoLockSync(dir, () => git(dir, 'fetch', '--quiet', 'origin')) !== undefined);
  if (!fetched.get(common)) return 'unpushed work: fetch failed, remote state unknown';
  const remote = git(dir, 'branch', '-r', '--contains', 'HEAD');
  if (remote === undefined || remote === '') return 'unpushed work: HEAD is not on the remote';
  return undefined;
}

/**
 * Plan one release pass: at most `batch` worktrees are checked (oldest
 * first), each through git. Returns what to remove and what to keep.
 */
export function planMergeRelease(now = Date.now(), batch = Infinity): ReleasePlan {
  const plan: ReleasePlan = { items: [], users: new Map(), kept: [] };
  if (!loadConfig().limits.releaseOnMerge) return plan;
  const all = allDispatches();
  const merged = mergedPrs(all);
  if (merged.size === 0) return plan;
  const chains = chainComponents(all);
  const trapped = trapWorktreeIds(worktreesDir());
  const usage = worktreeUsage();
  const ownerOf = new Map<string, string>();
  const owner = (id: string) => {
    if (!ownerOf.has(id)) ownerOf.set(id, dispatchWorktree(id, all.get(id)?.lane).owner);
    return ownerOf.get(id)!;
  };

  // Candidate owners, each with the PR and the chain it was reached through.
  const candidates = new Map<string, { pr: MergedPr; chain: Set<string> }>();
  // A dispatch with several PRs keeps its worktree while one of them is open.
  const openSibling = (id: string): boolean => {
    const k = all.get(id);
    const urls = k ? dispatchPrUrls(readEvidence(id, k.lane)) : [];
    return urls.length > 1 && urls.some((u) => readPr(parsePrRef(u)!.key)?.state === 'OPEN');
  };
  for (const pr of merged.values()) {
    for (const id of pr.owners) {
      if (openSibling(id)) continue;
      const chain = chains.get(id) ?? new Set([id]);
      const home = owner(id);
      const add = (o: string) => {
        if (!candidates.has(o)) candidates.set(o, { pr, chain });
      };
      add(home);
      for (const m of chain) {
        const k = all.get(m);
        if (!k) continue;
        const ev = readEvidence(m, k.lane);
        const url = prUrlOf(ev);
        const samePr = url !== undefined && parsePrRef(url)?.key === pr.key;
        const sameBranch = pr.headRef !== undefined && ev.branch === pr.headRef;
        if (owner(m) === home || samePr || sameBranch) add(owner(m));
      }
    }
  }

  const ordered = [...candidates.entries()]
    .filter(([o]) => fs.existsSync(worktreePath(o)) && !trapped.has(o))
    .map(([o, c]) => ({ o, c, from: usage.newest.get(o) ?? now }))
    .sort((a, b) => a.from - b.from || a.o.localeCompare(b.o));

  const fetched = new Map<string, boolean>();
  let checked = 0;
  for (const { o, c, from } of ordered) {
    if (checked >= batch) break;
    // Every user of the worktree, and every dispatch in the chain, finished.
    const users = [...all.values()].filter((k) => k.id === o || owner(k.id) === o);
    if (usage.live.has(o)) continue;
    if (![...c.chain].every((id) => finished(all.get(id))) || !users.every((k) => finished(k))) continue;
    checked++;
    const dir = worktreePath(o);
    const why = unsafe(dir, fetched);
    if (why) {
      plan.kept.push({ id: o, reason: why, pr: c.pr.key, at: new Date(now).toISOString() });
      continue;
    }
    plan.items.push({ kind: 'worktree', id: o, target: dir, ageDays: Math.floor((now - from) / DAY), bytes: 0, ageFrom: from });
    plan.users.set(o, users);
  }
  return plan;
}

/**
 * Run one release pass: remove the planned worktrees through the cull's
 * removal path, record the release in each user's evidence, and update the
 * kept list. Returns the released owner ids.
 */
export function runMergeRelease(now = Date.now(), batch = Infinity): { released: string[]; kept: KeptWorktree[] } {
  const plan = planMergeRelease(now, batch);
  const at = new Date(now).toISOString();
  const released: string[] = [];
  for (const item of plan.items) {
    applyCull([item]);
    if (fs.existsSync(item.target)) continue;
    released.push(item.id);
    for (const k of plan.users.get(item.id) ?? []) mergeEvidence(k.id, k.lane, { worktreeReleased: at });
  }
  // Keep entries this pass did not re-check; replace the ones it did.
  const checked = new Set([...plan.kept.map((k) => k.id), ...released]);
  const kept = [...readKeptWorktrees().filter((k) => !checked.has(k.id)), ...plan.kept];
  writeKeptWorktrees(kept);
  return { released, kept: plan.kept };
}
