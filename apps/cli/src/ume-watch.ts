import fs from 'node:fs';
import path from 'node:path';
import {
  activeIds,
  addWatch,
  laneOf,
  listWatches,
  readSessionClaim,
  readStatusLog,
  readWatch,
  removeWatch,
  TERMINAL_VERBS,
  updateWatch,
  readWatchEvents,
  observeUmeFeedback,
  umeOwnerFinished,
  WatchJournal,
  type Lane,
  type StatusEntry,
  type TurnWaitRegistration,
  type Watch,
} from '@lobstah/core';
import { watchSelfCommand } from './pr-watch.js';
import type { UmeRead } from '@lobstah/core';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function umeArtifact(text: string): string | undefined {
  return /https:\/\/app\.ume\.so\/a\/([A-Za-z0-9_-]+)(?=[\s/?#),.]|$)/.exec(text)?.[1];
}
export function umeTurnArtifact(wait: TurnWaitRegistration): string | undefined {
  const matched = /^(ume|ume-next) feedback ([A-Za-z0-9_-]+)$/.exec(wait.read);
  const command = matched?.[1],
    artifact = matched?.[2];
  return wait.from === 'ume' &&
    artifact &&
    [`${command} await ${artifact} --turn-line --since {cursor}`, `${command} await ${artifact} --since {cursor} --turn-line`].includes(
      wait.wait,
    )
    ? artifact
    : undefined;
}
function localContext(cwd: string): { project?: string; cursors?: Record<string, number> } {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.ume', 'next.json'), 'utf8')) ?? {};
  } catch {
    return {};
  }
}
export function addUmeWatch(
  artifact: string,
  opts: { forId?: string; cwd?: string; project?: string; org?: string; cursor?: string; everySecs?: number } = {},
): Watch {
  if (!ID.test(artifact)) throw new Error('watch add requires a ume artifact id');
  const key = `ume:${artifact}`;
  const existing = readWatch(key);
  const cwd = opts.cwd ?? process.cwd();
  const local = localContext(cwd);
  const project = opts.project ?? process.env.UME_PROJECT ?? local.project;
  return addWatch(key, `${watchSelfCommand()} watch check-ume ${artifact} --cursor {cursor}`, {
    typeId: 'ume',
    owner: opts.forId ? `dispatch:${opts.forId}` : existing?.owner,
    cursor: opts.cursor ?? String(local.cursors?.[artifact] ?? 0),
    everySecs: opts.everySecs,
    context: {
      ...existing?.context,
      cwd: existing?.context?.cwd ?? cwd,
      env: { UME_URL: 'https://app.ume.so', ...(project ? { UME_PROJECT: project } : {}), ...existing?.context?.env },
      org: existing?.context?.org ?? opts.org,
    },
    brief: `The watched source {key} has new review feedback:\n\n{summaries}\n\nRead the feedback in its recorded ume project, act on it, and report the outcome.`,
  });
}
export function registerUmeReview(id: string, lane: Lane, entry: StatusEntry, env = process.env): Watch | undefined {
  try {
    if (entry.verb !== 'paused') return undefined;
    const artifact = umeArtifact(`${entry.link ?? ''} ${entry.note ?? ''}`);
    const claim = readSessionClaim(id, lane);
    if (!artifact || !claim?.worktree || readWatch(`ume:${artifact}`)) return undefined;
    return addUmeWatch(artifact, { forId: id, cwd: claim.worktree, project: env.UME_PROJECT });
  } catch {
    return undefined;
  }
}
export function syncUmeWatches(): void {
  for (const lane of ['work', 'chore'] as Lane[])
    for (const id of activeIds(lane)) {
      const entry = readStatusLog(id, lane).at(-1);
      if (entry) registerUmeReview(id, lane, entry, {});
    }
  clearFinishedUmeWatches();
}
export function clearFinishedUmeWatches(): void {
  for (const w of listWatches()) {
    if (!w.key.startsWith('ume:') || !w.owner.startsWith('dispatch:')) continue;
    const id = w.owner.slice('dispatch:'.length),
      lane = laneOf(id);
    const last = lane ? readStatusLog(id, lane).at(-1) : undefined;
    if (!lane || (last && TERMINAL_VERBS.includes(last.verb))) {
      // Preserve a buffered tail until generic delivery acknowledges its receipts.
      if (readWatchEvents(w.key).length <= w.seen) removeWatch(w.key);
      else updateWatch({ ...w, done: true });
    }
  }
}
export type { UmeRead } from '@lobstah/core';

/** Compatibility command backed by the native source's context recovery and normalizer. */
export function runUmeCheck(artifact: string, cursor = '0', read?: UmeRead): string {
  if (!ID.test(artifact) || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
    throw new Error('watch check-ume requires an artifact id and numeric cursor');
  const watch = readWatch(`ume:${artifact}`),
    stored = new WatchJournal().read(`ume:${artifact}`);
  const owner = watch?.owner.startsWith('dispatch:')
    ? { kind: 'dispatch' as const, chainId: watch.owner.slice(9), grounds: 'home' }
    : { kind: 'helm' as const, grounds: 'home' };
  if (umeOwnerFinished(owner)) return JSON.stringify({ cursor, events: [], done: true });
  const checkpoint = stored?.type.id === 'ume' ? (stored.state as { project: string | null; org: string | null }) : undefined;
  const batch = observeUmeFeedback(
    artifact,
    cursor,
    { cwd: watch?.context?.cwd, project: watch?.context?.env?.UME_PROJECT, org: watch?.context?.org },
    checkpoint ?? { project: null, org: null },
    new Date().toISOString(),
    read,
  );
  const context = batch.payload as { project: string | null; org: string | null };
  if (stored?.type.id === 'ume')
    new WatchJournal().update(stored.key, (current) => {
      if (!current || current.generation !== stored.generation) return { result: undefined };
      current.state = { ...context };
      return { snapshot: current, result: undefined };
    });
  if (watch && context.project)
    updateWatch({
      ...watch,
      context: {
        ...watch.context,
        env: { ...watch.context?.env, UME_PROJECT: context.project },
        ...(context.org ? { org: context.org } : {}),
      },
    });
  return JSON.stringify({
    cursor: batch.cursor,
    events: batch.events.map((event) => ({ ...(event.data as object), summary: event.summary })),
    ...(batch.done ? { done: true } : {}),
  });
}
