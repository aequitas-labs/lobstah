import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from '@lobstah/core';

/** Gate verdict for one open PR, as of the last merge-loop tick. */
export interface MergeViewPr {
  number: number;
  url: string;
  headRef: string;
  headSha: string;
  mergeableState: string;
  /** waiting-approval | behind-updated | conflict-chore:<uuid> | rebase-failed | blocked | draft | merged */
  gate: string;
  /** Dispatch UUID when the branch is lobstah-made (lobstah/<uuid>). */
  uuid?: string;
}

/**
 * The merge loop's observation of the forge, persisted per tick so a status
 * view (`lobstah man tend`, a dashboard) can report PR state from disk — at
 * most one poll tick stale — without its own forge calls. Observational, not
 * load-bearing: deleting it loses nothing but history.
 */
export interface MergeView {
  updatedAt: string;
  repo: string;
  open: MergeViewPr[];
  /** PRs that left the open set, with how they left. Pruned after 48h. */
  recent: Array<{ number: number; url: string; disposition: 'merged' | 'closed'; at: string }>;
}

function viewPath(): string {
  return path.join(lobstahHome(), 'pickup', 'merge-view.json');
}

export function readMergeView(): MergeView | undefined {
  try {
    return JSON.parse(fs.readFileSync(viewPath(), 'utf8')) as MergeView;
  } catch {
    return undefined;
  }
}

export function writeMergeView(view: MergeView): void {
  const file = viewPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(view, null, 2));
  fs.renameSync(tmp, file);
}

const RECENT_RETENTION_MS = 48 * 3600_000;

/**
 * Fold this tick's observation into the persisted view: replace the open set,
 * and record a disposition for every PR that left it since last tick.
 */
export async function recordMergeView(
  repo: string,
  open: MergeViewPr[],
  disposition: (n: number) => Promise<'open' | 'merged' | 'closed'>,
  now = new Date(),
): Promise<void> {
  const prev = readMergeView();
  const recent = (prev?.recent ?? []).filter((r) => now.getTime() - Date.parse(r.at) < RECENT_RETENTION_MS);
  const stillOpen = new Set(open.map((p) => p.number));
  for (const was of prev?.open ?? []) {
    if (stillOpen.has(was.number)) continue;
    try {
      const d = await disposition(was.number);
      if (d === 'open') continue; // transient listing gap — keep it out of recent, it will reappear
      recent.push({ number: was.number, url: was.url, disposition: d, at: now.toISOString() });
    } catch {
      // forge blip: skip; next tick retries the disposition
    }
  }
  writeMergeView({ updatedAt: now.toISOString(), repo, open, recent });
}

/** The pickup mapping (tracker key → dispatch), read-only, for status views. */
export function readPickupMap(): Record<string, { uuid: string; kind: string; lastReported?: string }> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(lobstahHome(), 'pickup', 'state.json'), 'utf8')) as {
      map?: Record<string, { uuid: string; kind: string; lastReported?: string }>;
    };
    return raw.map ?? {};
  } catch {
    return {};
  }
}
