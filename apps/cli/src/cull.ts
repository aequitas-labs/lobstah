import { archiveWorktree } from '@lobstah/core';
import { configuredFolderOverlaps } from '@lobstah/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  acquireWorktreeLock,
  archiveRecords,
  releaseWorktreeLock,
  worktreeGitDir,
  dispatchWorktree,
  followUpAncestors,
  formatGB,
  laneDirs,
  listReleases,
  listReports,
  listDecisions,
  readDecisionAnswer,
  removeAnsweredDecision,
  decisionDir,
  listTraps,
  loadConfig,
  lobstahHome,
  parsePrRef,
  prRecordFile,
  readEvidence,
  reviewDispatchIds,
  readPr,
  readPrs,
  removeHelmReport,
  removeRelease,
  removePr,
  reportDir,
  statfsFreeBytes,
  storedDescriptor,
  toonKV,
  toonTable,
  worktreesDir,
  readTrapAnchor,
  inspectTrapWorktree,
  cleanupModifiedFiles,
  removeGhostWorktree,
  foldCatches,
  recordRosterRevision,
  planTrapCaches,
  recoverTrapCaches,
  planReviewWaitCaches,
  reviewWaitWorktrees,
  requestsDir,
  requestFilesDir,
  releaseFile,
  decisionsRoot,
  readArchivedDecision,
  readRunAttempt,
} from '@lobstah/core';
import type { CatchRef, FreeBytesReader, Lane } from '@lobstah/core';
import { ackFile, ackItemExists, listAcks, removeAck } from './acks.js';
import { mergedCullProofs, mergedWorktreeUnsafe } from './merged-worktree-safety.js';
import { runServerCull, type ServerCullOptions } from './cull-servers.js';
import type { ServerRuntime } from './cull-server-inventory.js';

export interface CullItem {
  kind: 'done' | 'worktree' | 'state' | 'ack' | 'pr' | 'report' | 'decision' | 'withdrawn' | 'release';
  id: string;
  target: string;
  ageDays: number;
  /** Bytes on disk. 0 when the plan was made without measuring. */
  bytes: number;
  /** Milliseconds since epoch the age is counted from (oldest first ordering). */
  ageFrom?: number;
  /** Pressure may discard this clean, published checkout while its PR waits for review. */
  reviewWait?: boolean;
}

export interface PlanOptions {
  /** The daemon can archive records while worktree retention is disabled. */
  worktrees?: boolean;
  /** Metadata has its own window; zero keeps it online. */
  recordRetentionDays?: number;
  /**
   * Measure each target. Only a dry run measures: an apply deletes without
   * sizing, because walking 190 GB of worktrees takes minutes.
   */
  measure?: boolean;
  /** Keep every dispatch whose PR is still open (the daemon's retention cull). */
  keepOpenPrs?: boolean;
}

const DAY = 86_400_000;

function walkBytes(target: string): number {
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) return fs.readdirSync(target).reduce((sum, name) => sum + walkBytes(path.join(target, name)), 0);
  return stat.isFile() ? stat.size : 0;
}

/**
 * The sizing functions, on one object so tests can spy on them and prove an
 * apply makes no size calls.
 */
export const sizing = {
  /** Recursive lstat walk. Exact apparent size; slow on large trees. */
  walk(target: string): number {
    return walkBytes(target);
  },
  /**
   * A worktree's size from one `du -sk`. Falls back to the JS walk where
   * `du` is missing (Windows) or fails.
   */
  worktree(target: string, platform: NodeJS.Platform = process.platform): number {
    if (platform !== 'win32') {
      try {
        const out = execFileSync('du', ['-sk', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const kb = Number(out.trim().split(/\s+/)[0]);
        if (Number.isFinite(kb)) return kb * 1024;
      } catch {
        // no du, or it failed: fall back to the walk
      }
    }
    return walkBytes(target);
  },
};

function idsIn(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => f.replace(/\.json$/, '')));
  } catch {
    return new Set();
  }
}

/** Explain why Git cannot prove that a checkout is clean and published. */
function worktreeSafetyReason(dir: string, heads: readonly string[] = []): string | undefined {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
  }).trim();
  try {
    if (cleanupModifiedFiles(dir)) return 'dirty';
    const published = heads.filter((head) => /^[a-f0-9]{40,64}$/i.test(head));
    const count = git('rev-list', '--count', 'HEAD', '--not', '--remotes', ...published);
    return count === '0' ? undefined : 'unpushed';
  } catch { return 'unknown Git state'; }
}

/** Lost gear has no dispatch proof: keep it unless Git proves it is published and clean. */
function orphanWorktreeSafe(dir: string): boolean { return worktreeSafetyReason(dir) === undefined; }

/** Review checkouts kept on finish must also survive later retention/pressure passes. */
function reviewWorktreeUsers(): Map<string, Set<string>> {
  const users = new Map<string, Set<string>>();
  const reviews = reviewDispatchIds();
  for (const id of idsIn(laneDirs('chore').done)) {
    if (!storedDescriptor(id, 'chore')?.readOnly && !reviews.has(id)) continue;
    const owner = dispatchWorktree(id, 'chore').owner;
    if (!users.has(owner)) users.set(owner, new Set());
    users.get(owner)!.add(id);
  }
  return users;
}

/**
 * Plan the sweep: aged catch (old done/ entries), lost gear (worktrees whose
 * dispatch is finished or gone), and stale state files for ids nothing knows.
 * Never touches queue/ or active/ — in-flight work is the daemon's.
 */
export function planCull(olderThanDays: number, now = Date.now(), opts: PlanOptions = {}): CullItem[] {
  const measure = opts.measure ?? true;
  const size = (target: string) => (measure ? sizing.walk(target) : 0);
  const worktreeCutoff = opts.worktrees === false ? -Infinity : now - olderThanDays * DAY;
  const recordDays = opts.recordRetentionDays ?? loadConfig().limits.recordRetentionDays;
  const cutoff = recordDays > 0 ? now - recordDays * DAY : -Infinity;
  const items: CullItem[] = [];
  const live = new Set<string>();
  const doneMtimes = new Map<string, number>();
  const referencedAttachmentState = new Set<string>();

  const retainReferences = (id: string, lane: Lane) => {
    for (const attachment of storedDescriptor(id, lane)?.attachments ?? []) {
      referencedAttachmentState.add(path.dirname(path.dirname(attachment.path)));
    }
  };

  const openPr = opts.keepOpenPrs ? openPrDispatches() : new Set<string>();

  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    for (const id of idsIn(d.queue)) { live.add(id); retainReferences(id, lane); }
    for (const id of idsIn(d.active)) { live.add(id); retainReferences(id, lane); }
    for (const id of idsIn(d.done)) {
      const p = path.join(d.done, id);
      if (openPr.has(id)) { live.add(id); retainReferences(id, lane); continue; }
      const m = fs.statSync(p).mtimeMs;
      doneMtimes.set(id, m);
      if (m >= cutoff) retainReferences(id, lane);
      if (m < cutoff) items.push({ kind: 'done', id, target: p, ageDays: Math.floor((now - m) / DAY), bytes: size(p), ageFrom: m });
    }
  }

  const wtRoot = path.join(lobstahHome(), 'worktrees');
  const trapped = trapWorktreeIds(wtRoot);
  const usage = worktreeUsage(opts.keepOpenPrs ? openPr : undefined);
  const reviews = reviewWorktreeUsers();
  const proofs = mergedCullProofs();
  const fetched = new Map<string, boolean>();
  const keptUsers = new Set<string>();
  const keptPrs = new Set<string>();
  // A batch may defer a worktree after planning. Keep its forge proof until
  // the checkout is actually gone, not merely scheduled for removal.
  for (const [owner, proof] of proofs) if (fs.existsSync(path.join(wtRoot, owner))) for (const key of proof.keys) keptPrs.add(key);
  for (const id of idsIn(wtRoot)) {
    if (live.has(id) || trapped.has(id) || usage.live.has(id)) continue;
    // A shared worktree ages from the newest dispatch that used it.
    const doneAt = usage.newest.get(id) ?? doneMtimes.get(id);
    const p = path.join(wtRoot, id);
    const from = doneAt ?? fs.statSync(p).mtimeMs;
    if (from >= worktreeCutoff) continue; // recent catch or orphan — keep for attach/swap
    if (configuredFolderOverlaps(p)) continue;
    const reviewUsers = reviews.get(id);
    if (reviewUsers && !orphanWorktreeSafe(p)) {
      for (const user of reviewUsers) { live.add(user); keptUsers.add(user); retainReferences(user, 'chore'); }
      continue;
    }
    const proof = proofs.get(id);
    if (proof && mergedWorktreeUnsafe(p, proof.heads, proof.trunk, fetched)) {
      for (const user of proof.users) { live.add(user); keptUsers.add(user); retainReferences(user, 'work'); retainReferences(user, 'chore'); }
      for (const key of proof.keys) keptPrs.add(key);
      continue;
    }
    if (readTrapAnchor(p)?.createdBy === 'soak') {
      if (inspectTrapWorktree(p).reason) continue;
    } else if (doneAt === undefined && !orphanWorktreeSafe(p)) continue;
    items.push({ kind: 'worktree', id, target: p, ageDays: Math.floor((now - from) / DAY), bytes: measure ? sizing.worktree(p) : 0, ageFrom: from });
  }
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'done' && keptUsers.has(items[i]!.id)) items.splice(i, 1);

  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    const groups = new Map<string, { mtime: number; bytes: number }>();
    for (const f of fs.readdirSync(d.state)) {
      const target = path.join(d.state, f);
      const directory = fs.statSync(target).isDirectory();
      if (directory && !fs.existsSync(path.join(target, 'attachments')) && !fs.existsSync(path.join(target, 'report.json'))) continue;
      const id = directory ? f : f.replace(/\.(status|events|evidence|catch-context|attn|notified|runner\.log|notes|activity)$/, '');
      if (id === f && !directory) continue;
      if (live.has(id) || (doneMtimes.get(id) ?? 0) >= cutoff || referencedAttachmentState.has(path.join(d.state, id))) continue;
      const previous = groups.get(id);
      groups.set(id, {
        mtime: Math.max(previous?.mtime ?? 0, fs.statSync(target).mtimeMs),
        bytes: (previous?.bytes ?? 0) + size(target),
      });
    }
    for (const [id, group] of groups) {
      const ageFrom = doneMtimes.get(id) ?? group.mtime;
      if (ageFrom >= cutoff) continue;
      items.push({ kind: 'state', id, target: path.join(d.state, `${id}.*`), ageDays: Math.floor((now - ageFrom) / DAY), bytes: group.bytes, ageFrom });
    }
  }

  // PR records for PRs merged or closed longer ago than the window (their
  // last observation is when the terminal state was seen). Open PRs never.
  for (const r of readPrs()) {
    if (r.state === 'OPEN' || keptPrs.has(r.key)) continue;
    const seen = Date.parse(r.observedAt) || now;
    if (seen < cutoff) items.push({ kind: 'pr', id: r.key, target: r.key, ageDays: Math.floor((now - seen) / DAY), bytes: size(prRecordFile(r.key)), ageFrom: seen });
  }

  // Helm reports age like a done dispatch: from when they were filed. A
  // dispatch's report goes with its state above.
  for (const r of listReports()) {
    if (!r.key.startsWith('report:helm:')) continue;
    const filed = Date.parse(r.filedAt) || now;
    const dir = reportDir(r.key)!;
    if (filed < cutoff) items.push({ kind: 'report', id: r.key, target: dir, ageDays: Math.floor((now - filed) / DAY), bytes: size(dir), ageFrom: filed });
  }

  // A decision goes once it is answered and the answer is older than the
  // window, with the request that carries the answer. A standing one never
  // ages out.
  for (const d of listDecisions()) {
    if (readRunAttempt(d.key)?.state === 'running') continue;
    const answer = readDecisionAnswer(d.key);
    if (!answer) continue;
    const at = Date.parse(answer.answeredAt) || now;
    const dir = decisionDir(d.key)!;
    if (at < cutoff) items.push({ kind: 'decision', id: d.key, target: dir, ageDays: Math.floor((now - at) / DAY), bytes: size(dir), ageFrom: at });
  }
  const withdrawn = path.join(decisionsRoot(), '.withdrawn');
  for (const entry of idsIn(withdrawn)) {
    const key = `decision:${entry}`;
    const meta = readArchivedDecision(key);
    if (!meta || meta.run) continue; // Run history has its own archive pass.
    const target = path.join(withdrawn, entry);
    const at = fs.statSync(target).mtimeMs;
    if (at < cutoff) items.push({ kind: 'withdrawn', id: key, target, ageDays: Math.floor((now - at) / DAY), bytes: size(target), ageFrom: at });
  }

  // Orphaned acks: the item is gone (dispatch culled — including by this
  // very sweep — PR merged or closed, watch removed). Keep orphaned acks
  // for the record window too.
  const culling = new Set(items.filter((i) => i.kind === 'done' || i.kind === 'state' || i.kind === 'report').map((i) => i.id));
  for (const a of listAcks()) {
    if (ackItemExists(a.key, culling)) continue;
    const at = Date.parse(a.at) || now;
    if (at >= cutoff) continue;
    items.push({ kind: 'ack', id: a.key, target: a.key, ageDays: Math.floor((now - at) / DAY), bytes: size(ackFile(a.key)), ageFrom: at });
  }
  // Question releases go the same way as acks: when their dispatch does.
  for (const r of listReleases()) {
    if (ackItemExists(r.key, culling)) continue;
    const at = Date.parse(r.releasedAt) || now;
    if (at >= cutoff) continue;
    items.push({ kind: 'release', id: r.key, target: r.key, ageDays: Math.floor((now - at) / DAY), bytes: 0, ageFrom: at });
  }
  return items;
}

/**
 * Dispatch ids whose PR is still open: a PR record lists the dispatch and
 * says OPEN, or the dispatch's own evidence does (the record wins when both
 * exist). A PR never observed is not known to be open.
 */
export function openPrDispatches(): Set<string> {
  const open = new Set<string>();
  for (const r of readPrs()) if (r.state === 'OPEN') for (const id of r.dispatches ?? []) open.add(id);
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of idsIn(laneDirs(lane).done)) {
      if (open.has(id)) continue;
      const ev = readEvidence(id, lane);
      const url = ev.pr?.url ?? ev.prUrl;
      const ref = url ? parsePrRef(url) : undefined;
      const record = ref ? readPr(ref.key) : undefined;
      if ((record ? record.state : ev.pr?.state) === 'OPEN') open.add(id);
    }
  }
  return open;
}

/**
 * Who uses each worktree under `worktrees/`, keyed by the owner id (the
 * directory name). A follow-up that reused its origin's worktree counts as
 * a user of the origin's directory.
 *
 * live: owners some queued or active dispatch uses or may use. A queued or
 * active dispatch keeps its own worktree and the worktree of every dispatch
 * in the chain behind it, since a queued follow-up may still reuse one.
 * With `openPr`, an owner some user of which has an open PR is live too.
 *
 * newest: per owner, the newest done-entry mtime among its users.
 */
export function worktreeUsage(openPr?: Set<string>): { live: Set<string>; newest: Map<string, number> } {
  const live = new Set<string>();
  const newest = new Map<string, number>();
  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    const inFlight = [...idsIn(d.queue), ...idsIn(d.active)];
    for (const id of inFlight) {
      live.add(dispatchWorktree(id, lane).owner);
      for (const up of followUpAncestors(id, lane)) live.add(dispatchWorktree(up).owner);
    }
    for (const id of idsIn(d.done)) {
      const owner = dispatchWorktree(id, lane).owner;
      if (openPr?.has(id)) live.add(owner);
      let m: number;
      try {
        m = fs.statSync(path.join(d.done, id)).mtimeMs;
      } catch {
        continue;
      }
      newest.set(owner, Math.max(newest.get(owner) ?? 0, m));
    }
  }
  return { live, newest };
}

/**
 * Worktree ids a soaking trap is anchored in. A live session works there, so
 * no cull removes them, whatever the dispatch's state.
 */
export function trapWorktreeIds(wtRoot: string): Set<string> {
  const ids = new Set<string>();
  // Native realpath expands Windows 8.3 names (RUNNER~1); registrations
  // store that form, lowercased on Windows.
  const real = (p: string) => {
    let r: string;
    try {
      r = fs.realpathSync.native(p);
    } catch {
      r = path.resolve(p);
    }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const root = real(wtRoot);
  for (const t of listTraps()) {
    if (typeof t.worktree !== 'string') continue;
    const rel = path.relative(root, real(t.worktree));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) ids.add(rel.split(path.sep)[0]!);
  }
  return ids;
}

/** The dispatch id an item belongs to, or its own key for PR records and non-dispatch acks. */
function groupOf(item: CullItem): string {
  if (item.kind === 'ack') return /^(?:work|chore):(.+)$/.exec(item.id)?.[1] ?? item.id;
  return item.id;
}

/** Worktree groups first, oldest first within each tier; keep dispatch records together. */
export function orderCull(items: CullItem[]): CullItem[] {
  const oldest = new Map<string, number>();
  const worktrees = new Set<string>();
  for (const item of items) {
    const g = groupOf(item);
    if (item.kind === 'worktree') worktrees.add(g);
    oldest.set(g, Math.min(oldest.get(g) ?? Infinity, item.ageFrom ?? Infinity));
  }
  const order = [...oldest.entries()].sort((a, b) =>
    Number(worktrees.has(b[0])) - Number(worktrees.has(a[0])) || a[1] - b[1] || a[0].localeCompare(b[0]),
  ).map(([g]) => g);
  const ranks = new Map(order.map((g, i) => [g, i]));
  return [...items].sort((a, b) => ranks.get(groupOf(a))! - ranks.get(groupOf(b))!);
}

/**
 * Worktrees the free-space guard may remove, oldest first: the worktree of
 * every finished dispatch, and every worktree nothing owns. Never a queued
 * or active dispatch's, never one a soaking trap works in, and never one
 * whose PR needs work. Clean, published review-wait checkouts qualify after caches. No age cutoff
 * and no sizing: the guard reads free space after each removal instead.
 */
export function planPressureCull(now = Date.now()): CullItem[] {
  const proofs = mergedCullProofs();
  const fetched = new Map<string, boolean>();
  const live = new Set<string>();
  const doneMtimes = new Map<string, number>();
  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    for (const id of idsIn(d.queue)) live.add(id);
    for (const id of idsIn(d.active)) live.add(id);
    for (const id of idsIn(d.done)) doneMtimes.set(id, fs.statSync(path.join(d.done, id)).mtimeMs);
  }
  const openPr = openPrDispatches();
  for (const id of openPr) live.add(id);
  const wtRoot = path.join(lobstahHome(), 'worktrees');
  for (const id of trapWorktreeIds(wtRoot)) live.add(id);
  const usage = worktreeUsage(openPr);
  const waiting = new Map(reviewWaitWorktrees().map((item) => [item.owner, item]));
  const reviews = reviewWorktreeUsers();
  for (const id of usage.live) live.add(id);
  for (const owner of waiting.keys()) live.delete(owner);
  const items: CullItem[] = [];
  for (const id of idsIn(wtRoot)) {
    if (live.has(id)) continue;
    const p = path.join(wtRoot, id);
    if (configuredFolderOverlaps(p)) continue;
    const reviewWait = waiting.get(id);
    if (reviewWait && worktreeSafetyReason(p, reviewWait.heads)) continue;
    if (reviews.has(id) && !orphanWorktreeSafe(p)) continue;
    const proof = proofs.get(id);
    if (proof && mergedWorktreeUnsafe(p, proof.heads, proof.trunk, fetched)) continue;
    const doneAt = usage.newest.get(id) ?? doneMtimes.get(id);
    if (readTrapAnchor(p)?.createdBy === 'soak') {
      if (inspectTrapWorktree(p).reason) continue;
    } else if (doneAt === undefined && !orphanWorktreeSafe(p)) continue;
    const from = doneAt ?? fs.statSync(p).mtimeMs;
    items.push({ kind: 'worktree', id, target: p, ageDays: Math.floor((now - from) / DAY), bytes: 0, ageFrom: from, ...(reviewWait ? { reviewWait: true } : {}) });
  }
  return items.sort((a, b) => a.ageFrom! - b.ageFrom! || a.id.localeCompare(b.id));
}

/**
 * Worktrees are removed through git when the owning repo is still known.
 * `git worktree remove` keeps the branch: a culled dispatch's commits stay.
 */
export function removeWorktree(id: string, dir: string, reviewWait = false): void {
  if (configuredFolderOverlaps(dir)) throw new Error(`configured working folder is never culled: ${dir}`);
  const anchor = readTrapAnchor(dir);
  if (anchor?.createdBy === 'soak') {
    // The trap's revision goes under its protected ref first; the roster records it.
    recordRosterRevision(anchor.trapId, removeGhostWorktree(dir).revision);
    return; // Never fall through to force removal of a trap checkout.
  }
  if (!archiveWorktree(dir, id).saved) return;
  if (reviewWait || reviewWorktreeUsers().has(id) || !worktreeUsage().newest.has(id)) {
    // Recheck reviews and orphans at removal; only disposable changes may remain.
    // Never fall through to recursive removal when verification fails.
    try {
      const waiting = reviewWait ? reviewWaitWorktrees().find((item) => item.owner === id) : undefined;
      if (reviewWait && !waiting) return;
      if (worktreeSafetyReason(dir, waiting?.heads)) return;
      const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      execFileSync('git', ['--git-dir', common, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
    } catch { /* leave it for the next cleanup attempt */ }
    return;
  }
  for (const lane of ['work', 'chore'] as Lane[]) {
    const descFile = path.join(laneDirs(lane).done, id, 'descriptor.json');
    try {
      const desc = JSON.parse(fs.readFileSync(descFile, 'utf8')) as { repo: string };
      const repo = loadConfig().repos[desc.repo];
      if (repo) {
        execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: repo.path, stdio: 'ignore' });
        return;
      }
    } catch {
      // fall through
    }
  }
  // The owner's done entry may be gone while a follow-up that reused its
  // worktree kept it alive: ask the worktree itself for its repo.
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (common) {
      execFileSync('git', ['--git-dir', common, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
      return;
    }
  } catch {
    // fall through to the blunt path
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The dispatches whose state files these items remove, with their lane. */
function culledState(items: CullItem[]): CatchRef[] {
  const lanes = new Map((['work', 'chore'] as Lane[]).map((lane) => [path.resolve(laneDirs(lane).state), lane]));
  return items.flatMap((item) => {
    const lane = item.kind === 'state' ? lanes.get(path.resolve(path.dirname(item.target))) : undefined;
    return lane ? [{ id: item.id, lane }] : [];
  });
}

/** Expand exactly the paths each metadata removal below will consume. */
function archiveCull(items: CullItem[]): void {
  const allTargets: string[] = [];
  const keys = new Set<string>();
  for (const item of items) {
    if (item.kind === 'worktree') continue;
    let targets = [item.target];
    let key = item.id;
    if (item.kind === 'done' || item.kind === 'state') {
      const lane = (['work', 'chore'] as Lane[]).find((lane) =>
        path.resolve(item.kind === 'done' ? laneDirs(lane).done : laneDirs(lane).state) === path.resolve(path.dirname(item.target)))!;
      key = `${lane}:${item.id}`;
      if (item.kind === 'state') targets = fs.readdirSync(path.dirname(item.target))
        .filter((f) => f === item.id || f.startsWith(`${item.id}.`)).map((f) => path.join(path.dirname(item.target), f));
    } else if (item.kind === 'ack') targets = [ackFile(item.id)];
    else if (item.kind === 'pr') targets = [prRecordFile(item.id)];
    else if (item.kind === 'release') targets = [releaseFile(item.id)];
    else if (item.kind === 'decision') {
      const answer = readDecisionAnswer(item.id);
      if (answer && /^[0-9a-f-]{36}$/.test(answer.request)) targets.push(path.join(requestsDir(), `${answer.request}.json`), requestFilesDir(answer.request));
    }
    keys.add(key);
    allTargets.push(...targets);
  }
  archiveRecords([...keys], allTargets);
}

export function applyCull(items: CullItem[]): CullItem[] {
  // A background pass may outlive its plan. A warm lock prevents a follow-up
  // claiming the checkout while current liveness is checked and it is removed.
  const blocked = new Set<string>();
  for (const item of items.filter((i) => i.kind === 'worktree')) {
    if (!fs.existsSync(item.target)) continue;
    const lockId = `cull-${process.pid}-${item.id}`;
    const locked = worktreeGitDir(item.target) !== undefined;
    if (locked && acquireWorktreeLock(item.target, lockId, 'work', 'warm')) { blocked.add(item.id); continue; }
    try {
      const reviewWait = item.reviewWait && reviewWaitWorktrees().some((worktree) => worktree.owner === item.id);
      if (trapWorktreeIds(worktreesDir()).has(item.id) ||
          worktreeUsage(reviewWait ? undefined : openPrDispatches()).live.has(item.id) || (item.reviewWait && !reviewWait)) {
        blocked.add(item.id);
        continue;
      }
      removeWorktree(item.id, item.target, reviewWait);
      if (fs.existsSync(item.target)) blocked.add(item.id);
    } finally {
      if (locked) releaseWorktreeLock(item.target, lockId);
    }
  }
  items = items.filter((i) => !blocked.has(groupOf(i)));
  // Recheck records too: a detached plan may predate a new follow-up or reopened PR.
  const protectedIds = new Set(openPrDispatches());
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of [...idsIn(laneDirs(lane).queue), ...idsIn(laneDirs(lane).active)]) {
      protectedIds.add(id);
      for (const ancestor of followUpAncestors(id, lane)) protectedIds.add(ancestor);
    }
  }
  items = items.filter((item) => item.kind === 'worktree' || !protectedIds.has(groupOf(item)) &&
    !(item.kind === 'pr' && readPr(item.id)?.state === 'OPEN') &&
    !(item.kind === 'decision' && (!readDecisionAnswer(item.id) || readRunAttempt(item.id)?.state === 'running')));
  archiveCull(items);
  // Catches outlive their state: fold them into stats.json before the state goes.
  foldCatches(culledState(items));
  for (const item of items.filter((i) => i.kind === 'done')) fs.rmSync(item.target, { recursive: true, force: true });
  for (const item of items.filter((i) => i.kind === 'ack')) removeAck(item.target);
  for (const item of items.filter((i) => i.kind === 'pr')) removePr(item.target);
  for (const item of items.filter((i) => i.kind === 'report')) removeHelmReport(item.id);
  for (const item of items.filter((i) => i.kind === 'decision')) removeAnsweredDecision(item.id);
  for (const item of items.filter((i) => i.kind === 'withdrawn')) fs.rmSync(item.target, { recursive: true, force: true });
  for (const item of items.filter((i) => i.kind === 'release')) removeRelease(item.id);
  for (const item of items.filter((i) => i.kind === 'state')) {
    const dir = path.dirname(item.target);
    for (const f of fs.readdirSync(dir)) {
      if (f === item.id || f.startsWith(`${item.id}.`)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    }
  }
  return items;
}

/** Explain retained disk space only in previews; deletion passes never size kept trees. */
export function keptWorktreeSummary(removing: ReadonlySet<string> = new Set()): string[] {
  const inUse = worktreeUsage().live;
  const open = worktreeUsage(openPrDispatches()).live;
  const trapped = trapWorktreeIds(worktreesDir());
  const groups = new Map<string, { count: number; bytes: number }>();
  for (const id of idsIn(worktreesDir())) {
    if (removing.has(id)) continue;
    const directory = path.join(worktreesDir(), id);
    const reason = trapped.has(id) ? 'kept for live traps' : inUse.has(id) ? 'kept for queued or active dispatches'
      : worktreeSafetyReason(directory) ?? (open.has(id) ? 'kept for open PRs' : 'kept by retention or checkout protection');
    const group = groups.get(reason) ?? { count: 0, bytes: 0 };
    group.count++;
    group.bytes += sizing.worktree(directory);
    groups.set(reason, group);
  }
  return [...groups].map(([reason, group]) => `${group.count} ${reason}, ${formatGB(group.bytes)}`);
}

/**
 * `lobstah cull [--older-than <days>] [--apply]`. A dry run measures each
 * target and prints the sizes. An apply measures nothing: it deletes, then
 * reports the change in free space on the worktrees volume.
 */
export function runCull(days: number, apply: boolean, freeBytes: FreeBytesReader = statfsFreeBytes, now = Date.now()): string {
  const lines: string[] = [];
  // Under pressure, disposable caches come before removing whole worktrees, including a manual --apply.
  if (apply) recoverTrapCaches(loadConfig(), worktreesDir(), freeBytes, (message) => lines.push(message));
  const plan = planCull(days, now, { measure: !apply, keepOpenPrs: true, recordRetentionDays: loadConfig().limits.recordRetentionDays });
  if (!apply) {
    const caches = planTrapCaches();
    if (caches.length > 0) lines.push(`caches: ${formatGB(caches.reduce((bytes, cache) => bytes + cache.bytes, 0))} clearable in ${caches.length} idle trap(s)`);
    const reviewCaches = planReviewWaitCaches();
    if (reviewCaches.length > 0) lines.push(`review caches: ${formatGB(reviewCaches.reduce((bytes, cache) => bytes + cache.bytes, 0))} clearable in ${reviewCaches.length} checkout(s) waiting for review`);
    lines.push(toonTable('cull', plan.map((i) => ({ kind: i.kind, id: i.id, ageDays: i.ageDays, bytes: i.bytes })), ['kind', 'id', 'ageDays', 'bytes']));
    lines.push(...keptWorktreeSummary(new Set(plan.filter((item) => item.kind === 'worktree').map((item) => item.id))));
    const total = plan.reduce((sum, item) => sum + item.bytes, 0);
    lines.push(toonKV({ totalBytes: total, total: formatGB(total) }));
    if (plan.length > 0) lines.push('dry run — pass --apply to remove');
    return lines.join('\n');
  }
  lines.push(toonTable('cull', plan.map((i) => ({ kind: i.kind, id: i.id, ageDays: i.ageDays })), ['kind', 'id', 'ageDays']));
  if (plan.length === 0) return lines.join('\n');
  const read = (): number | undefined => {
    try {
      return freeBytes(worktreesDir());
    } catch {
      return undefined;
    }
  };
  const before = read();
  const applied = applyCull(plan);
  const after = read();
  const freed = before !== undefined && after !== undefined ? Math.max(0, after - before) : undefined;
  lines.push(`applied: ${applied.length} removed` + (freed !== undefined ? `, ${formatGB(freed)} freed (free-space change on the worktrees volume)` : ''));
  return lines.join('\n');
}

/** Manual cull stops idle worktree services before removing their checkout or state. */
export async function runCullWithServers(days: number, apply: boolean, options: ServerCullOptions = {}, runtime?: ServerRuntime): Promise<string> {
  const servers = await runServerCull(apply, options, runtime);
  return `${servers}\n${runCull(days, apply)}`;
}
