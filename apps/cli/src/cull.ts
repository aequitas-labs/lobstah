import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { laneDirs, loadConfig, lobstahHome, prRecordFile, readPrs, removePr, storedDescriptor } from '@lobstah/core';
import type { Lane } from '@lobstah/core';
import { ackFile, ackItemExists, listAcks, removeAck } from './acks.js';

export interface CullItem {
  kind: 'done' | 'worktree' | 'state' | 'ack' | 'pr';
  id: string;
  target: string;
  ageDays: number;
  bytes: number;
}

const DAY = 86_400_000;

function bytesAt(target: string): number {
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) return fs.readdirSync(target).reduce((sum, name) => sum + bytesAt(path.join(target, name)), 0);
  return stat.isFile() ? stat.size : 0;
}

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
export function planCull(olderThanDays: number, now = Date.now()): CullItem[] {
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

  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    for (const id of idsIn(d.queue)) { live.add(id); retainReferences(id, lane); }
    for (const id of idsIn(d.active)) { live.add(id); retainReferences(id, lane); }
    for (const id of idsIn(d.done)) {
      const p = path.join(d.done, id);
      const m = fs.statSync(p).mtimeMs;
      doneMtimes.set(id, m);
      if (m >= cutoff) retainReferences(id, lane);
      if (m < cutoff) items.push({ kind: 'done', id, target: p, ageDays: Math.floor((now - m) / DAY), bytes: bytesAt(p) });
    }
  }

  const wtRoot = path.join(lobstahHome(), 'worktrees');
  for (const id of idsIn(wtRoot)) {
    if (live.has(id)) continue;
    const doneAt = doneMtimes.get(id);
    if (doneAt !== undefined && doneAt >= cutoff) continue; // recent catch — keep for attach/swap
    const p = path.join(wtRoot, id);
    items.push({ kind: 'worktree', id, target: p, ageDays: Math.floor((now - fs.statSync(p).mtimeMs) / DAY), bytes: bytesAt(p) });
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
        bytes: (previous?.bytes ?? 0) + bytesAt(target),
      });
    }
    for (const [id, group] of groups) {
      const ageFrom = doneMtimes.get(id) ?? group.mtime;
      if (ageFrom >= cutoff) continue;
      items.push({ kind: 'state', id, target: path.join(d.state, `${id}.*`), ageDays: Math.floor((now - ageFrom) / DAY), bytes: group.bytes });
    }
  }

  // PR records for PRs merged or closed longer ago than the window (their
  // last observation is when the terminal state was seen). Open PRs never.
  for (const r of readPrs()) {
    if (r.state === 'OPEN') continue;
    const seen = Date.parse(r.observedAt) || now;
    if (seen < cutoff) items.push({ kind: 'pr', id: r.key, target: r.key, ageDays: Math.floor((now - seen) / DAY), bytes: bytesAt(prRecordFile(r.key)) });
  }

  // Orphaned acks: the item is gone (dispatch culled — including by this
  // very sweep — PR merged or closed, watch removed). Acks never age out
  // on their own, so no cutoff applies here.
  const culling = new Set(items.filter((i) => i.kind === 'done' || i.kind === 'state').map((i) => i.id));
  for (const a of listAcks()) {
    if (ackItemExists(a.key, culling)) continue;
    items.push({ kind: 'ack', id: a.key, target: a.key, ageDays: Math.floor((now - (Date.parse(a.at) || now)) / DAY), bytes: bytesAt(ackFile(a.key)) });
  }
  return items;
}

/** Worktrees are removed through git when the owning repo is still known. */
function removeWorktree(id: string, dir: string): void {
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
      // fall through to the blunt path
    }
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
