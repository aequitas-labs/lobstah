import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  dispatchWorktree,
  followUpAncestors,
  formatGB,
  laneDirs,
  listTraps,
  loadConfig,
  lobstahHome,
  parsePrRef,
  prRecordFile,
  readEvidence,
  readPr,
  readPrs,
  removePr,
  statfsFreeBytes,
  storedDescriptor,
  toonKV,
  toonTable,
  worktreesDir,
} from '@lobstah/core';
import type { FreeBytesReader, Lane } from '@lobstah/core';
import { ackFile, ackItemExists, listAcks, removeAck } from './acks.js';

export interface CullItem {
  kind: 'done' | 'worktree' | 'state' | 'ack' | 'pr';
  id: string;
  target: string;
  ageDays: number;
  /** Bytes on disk. 0 when the plan was made without measuring. */
  bytes: number;
  /** Milliseconds since epoch the age is counted from (oldest first ordering). */
  ageFrom?: number;
}

export interface PlanOptions {
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

/**
 * Plan the sweep: aged catch (old done/ entries), lost gear (worktrees whose
 * dispatch is finished or gone), and stale state files for ids nothing knows.
 * Never touches queue/ or active/ — in-flight work is the daemon's.
 */
export function planCull(olderThanDays: number, now = Date.now(), opts: PlanOptions = {}): CullItem[] {
  const measure = opts.measure ?? true;
  const size = (target: string) => (measure ? sizing.walk(target) : 0);
  const cutoff = now - olderThanDays * DAY;
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
  for (const id of idsIn(wtRoot)) {
    if (live.has(id) || trapped.has(id) || usage.live.has(id)) continue;
    // A shared worktree ages from the newest dispatch that used it.
    const doneAt = usage.newest.get(id) ?? doneMtimes.get(id);
    if (doneAt !== undefined && doneAt >= cutoff) continue; // recent catch — keep for attach/swap
    const p = path.join(wtRoot, id);
    const from = doneAt ?? fs.statSync(p).mtimeMs;
    items.push({ kind: 'worktree', id, target: p, ageDays: Math.floor((now - from) / DAY), bytes: measure ? sizing.worktree(p) : 0, ageFrom: from });
  }

  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    const groups = new Map<string, { mtime: number; bytes: number }>();
    for (const f of fs.readdirSync(d.state)) {
      const target = path.join(d.state, f);
      const directory = fs.statSync(target).isDirectory();
      if (directory && !fs.existsSync(path.join(target, 'attachments'))) continue;
      const id = directory ? f : f.replace(/\.(status|events|evidence|attn|notified|runner\.log)$/, '');
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
    if (r.state === 'OPEN') continue;
    const seen = Date.parse(r.observedAt) || now;
    if (seen < cutoff) items.push({ kind: 'pr', id: r.key, target: r.key, ageDays: Math.floor((now - seen) / DAY), bytes: size(prRecordFile(r.key)), ageFrom: seen });
  }

  // Orphaned acks: the item is gone (dispatch culled — including by this
  // very sweep — PR merged or closed, watch removed). Acks never age out
  // on their own, so no cutoff applies here.
  const culling = new Set(items.filter((i) => i.kind === 'done' || i.kind === 'state').map((i) => i.id));
  for (const a of listAcks()) {
    if (ackItemExists(a.key, culling)) continue;
    const at = Date.parse(a.at) || now;
    items.push({ kind: 'ack', id: a.key, target: a.key, ageDays: Math.floor((now - at) / DAY), bytes: size(ackFile(a.key)), ageFrom: at });
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
function trapWorktreeIds(wtRoot: string): Set<string> {
  const ids = new Set<string>();
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
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

/**
 * Bound one pass: keep the items of the `maxGroups` oldest groups (a group
 * is one dispatch id, or one PR record, or one stray ack). An ack whose
 * dispatch is deferred to a later pass is deferred with it.
 */
export function limitBatch(items: CullItem[], maxGroups: number): { batch: CullItem[]; deferred: number } {
  const oldest = new Map<string, number>();
  for (const item of items) {
    const g = groupOf(item);
    oldest.set(g, Math.min(oldest.get(g) ?? Infinity, item.ageFrom ?? Infinity));
  }
  const order = [...oldest.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([g]) => g);
  const keep = new Set(order.slice(0, maxGroups));
  return { batch: items.filter((i) => keep.has(groupOf(i))), deferred: order.length - keep.size };
}

/**
 * Worktrees the free-space guard may remove, oldest first: the worktree of
 * every finished dispatch, and every worktree nothing owns. Never a queued
 * or active dispatch's, never one a soaking trap works in, and never one
 * whose PR is still open. No age cutoff
 * and no sizing: the guard reads free space after each removal instead.
 */
export function planPressureCull(now = Date.now()): CullItem[] {
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
  for (const id of usage.live) live.add(id);
  const items: CullItem[] = [];
  for (const id of idsIn(wtRoot)) {
    if (live.has(id)) continue;
    const p = path.join(wtRoot, id);
    const from = usage.newest.get(id) ?? doneMtimes.get(id) ?? fs.statSync(p).mtimeMs;
    items.push({ kind: 'worktree', id, target: p, ageDays: Math.floor((now - from) / DAY), bytes: 0, ageFrom: from });
  }
  return items.sort((a, b) => a.ageFrom! - b.ageFrom! || a.id.localeCompare(b.id));
}

/**
 * Worktrees are removed through git when the owning repo is still known.
 * `git worktree remove` keeps the branch: a culled dispatch's commits stay.
 */
export function removeWorktree(id: string, dir: string): void {
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

export function applyCull(items: CullItem[]): void {
  // Worktrees first: their done/ descriptors are needed to find the owning repo.
  for (const item of items.filter((i) => i.kind === 'worktree')) removeWorktree(item.id, item.target);
  for (const item of items.filter((i) => i.kind === 'done')) fs.rmSync(item.target, { recursive: true, force: true });
  for (const item of items.filter((i) => i.kind === 'ack')) removeAck(item.target);
  for (const item of items.filter((i) => i.kind === 'pr')) removePr(item.target);
  for (const item of items.filter((i) => i.kind === 'state')) {
    const dir = path.dirname(item.target);
    for (const f of fs.readdirSync(dir)) {
      if (f === item.id || f.startsWith(`${item.id}.`)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    }
  }
}

/**
 * `lobstah cull [--older-than <days>] [--apply]`. A dry run measures each
 * target and prints the sizes. An apply measures nothing: it deletes, then
 * reports the change in free space on the worktrees volume.
 */
export function runCull(days: number, apply: boolean, freeBytes: FreeBytesReader = statfsFreeBytes, now = Date.now()): string {
  const plan = planCull(days, now, { measure: !apply });
  const lines: string[] = [];
  if (!apply) {
    lines.push(toonTable('cull', plan.map((i) => ({ kind: i.kind, id: i.id, ageDays: i.ageDays, bytes: i.bytes })), ['kind', 'id', 'ageDays', 'bytes']));
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
  applyCull(plan);
  const after = read();
  const freed = before !== undefined && after !== undefined ? Math.max(0, after - before) : undefined;
  lines.push(`applied: ${plan.length} removed` + (freed !== undefined ? `, ${formatGB(freed)} freed (free-space change on the worktrees volume)` : ''));
  return lines.join('\n');
}
