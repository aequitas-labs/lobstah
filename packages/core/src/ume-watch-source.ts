import { WatchCommandError } from '@lobstah/watch-types';
import { spawnSync } from 'node:child_process';
import { UmeWatchType, UME_ARTIFACT_ID } from '@lobstah/watch-types';
import type { UmeWatchContext, UmeWatchOptions, UmeWatchState, WatchRegistrationPolicy, WatchObservationBatch, WatchOwner } from '@lobstah/watch-types';
import { laneOf } from './worktrees.js';
import { readStatusLog } from './status.js';
import { TERMINAL_VERBS } from './types.js';

/** Provider reads receive the recorded project explicitly, independently of the ambient environment. */
export type UmeRead = (args: string[], cwd?: string, project?: string) => unknown;
export interface UmeWatchSourceOptions {
  registration?: WatchRegistrationPolicy;
  read?: UmeRead;
}
export const readUme: UmeRead = (args, cwd, project) => {
  const result = spawnSync('ume', args, {
    cwd,
    env: { ...process.env, UME_URL: 'https://app.ume.so', UME_NO_BROWSER: '1', ...(project ? { UME_PROJECT: project } : {}) },
    shell: process.platform === 'win32',
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new WatchCommandError(result.stderr?.trim() || result.error?.message || 'ume check failed', result.status ?? undefined);
  return JSON.parse(result.stdout);
};

/** Task completion stops new reads without discarding already checkpointed feedback. */
export function umeOwnerFinished(owner: WatchOwner): boolean {
  if (owner.kind !== 'dispatch') return false;
  const lane = laneOf(owner.chainId),
    last = lane ? readStatusLog(owner.chainId, lane).at(-1) : undefined;
  return !lane || !!(last && TERMINAL_VERBS.includes(last.verb));
}
interface ProjectListing {
  current?: string;
  projects?: Array<{ project: string; org?: string }>;
}
const missing = (error: unknown): boolean =>
  /no.such.artifact|no.such.project|no stored agent token reaches|agent_token_scope/.test(String(error));

/** Poll and stream paths use the same stable sequence IDs and do not consume ume’s human read cursor. */
export function normalizeUmeFeedback(
  artifact: string,
  cursor: string,
  value: unknown,
  state: UmeWatchState,
  now: string,
): WatchObservationBatch<string> {
  const data = value as { feedbackCount?: number; batches?: Array<{ cursor: number; entries: Array<{ seq: number; kind: string }> }> };
  if (
    !data ||
    !Number.isSafeInteger(data.feedbackCount) ||
    data.feedbackCount! < 0 ||
    (data.feedbackCount! > 0 && !Array.isArray(data.batches))
  )
    throw new Error('ume returned invalid feedback');
  const events = new Map<string, WatchObservationBatch<string>['events'][number]>();
  let next = Number(cursor);
  for (const batch of data.batches ?? []) {
    if (!batch || !Number.isSafeInteger(batch.cursor) || batch.cursor < 0 || !Array.isArray(batch.entries))
      throw new Error('ume returned invalid feedback cursor');
    next = Math.max(next, batch.cursor);
    for (const entry of batch.entries) {
      if (!entry || !Number.isSafeInteger(entry.seq) || entry.seq < 0 || typeof entry.kind !== 'string' || !entry.kind)
        throw new Error('ume returned invalid feedback entry');
      next = Math.max(next, entry.seq);
      if (entry.seq <= Number(cursor)) continue;
      const id = String(entry.seq);
      if (!events.has(id))
        events.set(id, {
          id,
          kind: entry.kind,
          at: now,
          summary: `${entry.kind}: ${state.project ? `set UME_PROJECT=${state.project}, then run ` : ''}ume feedback ${artifact} --since ${cursor}`,
          data: { seq: entry.seq, kind: entry.kind },
        });
    }
  }
  return {
    cursor: String(next),
    events: [...events.values()].sort((left, right) => Number(left.id) - Number(right.id)),
    payload: { ...state },
  };
}

/** Recover legacy project context once; the reducer saves the result with the cursor and outbox. */
export function observeUmeFeedback(
  artifact: string,
  cursor: string,
  options: UmeWatchOptions,
  prior: UmeWatchState,
  now: string,
  read: UmeRead = readUme,
): WatchObservationBatch<string> {
  let project = prior.project ?? options.project,
    org = prior.org ?? options.org;
  if (!project || !org) {
    const listing = read(['projects', '--json'], options.cwd) as ProjectListing;
    project ??= listing.current;
    org ??= listing.projects?.find((candidate) => candidate.project === project)?.org;
  }
  const args = ['feedback', artifact, '--peek', '--since', cursor, '--json'];
  let data: unknown;
  try {
    data = read(args, options.cwd, project);
  } catch (error) {
    if (!missing(error)) throw error;
    const listing = read(['projects', '--json'], options.cwd) as ProjectListing;
    let found = false;
    for (const candidate of listing.projects ?? []) {
      if (!UME_ARTIFACT_ID.test(candidate.project) || candidate.project === project) continue;
      try {
        data = read(args, options.cwd, candidate.project);
      } catch (next) {
        if (!missing(next)) throw next;
        continue;
      }
      project = candidate.project;
      org = candidate.org;
      found = true;
      break;
    }
    if (!found) throw error;
  }
  return normalizeUmeFeedback(artifact, cursor, data, { project: project ?? null, org: org ?? null }, now);
}

/** The native adapter bypasses the compatibility subprocess while custom check commands keep their behavior. */
export function createUmeWatchType(options: UmeWatchSourceOptions = {}): UmeWatchType {
  return new UmeWatchType({
    registration: options.registration,
    observe({ snapshot, now }: UmeWatchContext) {
      if (umeOwnerFinished(snapshot.owner)) return { cursor: snapshot.cursor, events: [], done: true };
      return observeUmeFeedback(snapshot.reference.artifact, snapshot.cursor, snapshot.options, snapshot.state, now, options.read);
    },
    failure(error) {
      return {
        kind: 'ume',
        ...(error instanceof WatchCommandError && error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
        message: error instanceof Error ? error.message : String(error),
        remedy: 'Check the recorded ume project and agent access, then release or retry the watch.',
      };
    },
  });
}
