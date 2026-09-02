import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { laneDirs, loadConfig, lobstahHome } from '@lobstah/core';
import type { Lane } from '@lobstah/core';

export interface CullItem {
  kind: 'done' | 'worktree' | 'state';
  id: string;
  target: string;
  ageDays: number;
}

const DAY = 86_400_000;

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

  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    for (const id of idsIn(d.queue)) live.add(id);
    for (const id of idsIn(d.active)) live.add(id);
    for (const id of idsIn(d.done)) {
      const p = path.join(d.done, id);
      const m = fs.statSync(p).mtimeMs;
      doneMtimes.set(id, m);
      if (m < cutoff) items.push({ kind: 'done', id, target: p, ageDays: Math.floor((now - m) / DAY) });
    }
  }

  const wtRoot = path.join(lobstahHome(), 'worktrees');
  for (const id of idsIn(wtRoot)) {
    if (live.has(id)) continue;
    const doneAt = doneMtimes.get(id);
    if (doneAt !== undefined && doneAt >= cutoff) continue; // recent catch — keep for attach/swap
    const p = path.join(wtRoot, id);
    items.push({ kind: 'worktree', id, target: p, ageDays: Math.floor((now - fs.statSync(p).mtimeMs) / DAY) });
  }

  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    const seen = new Set<string>();
    for (const f of fs.readdirSync(d.state)) {
      const id = f.replace(/\.(status|events|evidence|attn|notified|runner\.log)$/, '');
      if (id === f || seen.has(id) || live.has(id) || doneMtimes.has(id)) continue;
      const m = fs.statSync(path.join(d.state, f)).mtimeMs;
      if (m >= cutoff) continue;
      seen.add(id);
      items.push({ kind: 'state', id, target: path.join(d.state, `${id}.*`), ageDays: Math.floor((now - m) / DAY) });
    }
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
  for (const item of items.filter((i) => i.kind === 'state')) {
    const dir = path.dirname(item.target);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${item.id}.`)) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
}
