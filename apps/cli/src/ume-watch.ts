import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  activeIds, addWatch, laneOf, listWatches, readSessionClaim, readStatusLog, readWatch,
  removeWatch, TERMINAL_VERBS, updateWatch,
  type Lane, type StatusEntry, type TurnWaitRegistration, type Watch,
} from '@lobstah/core';
import { watchSelfCommand } from './pr-watch.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function umeArtifact(text: string): string | undefined {
  return /https:\/\/app\.ume\.so\/a\/([A-Za-z0-9_-]+)(?=[\s/?#),.]|$)/.exec(text)?.[1];
}
export function umeTurnArtifact(wait: TurnWaitRegistration): string | undefined {
  const artifact = /^ume feedback ([A-Za-z0-9_-]+)$/.exec(wait.read)?.[1];
  return wait.from === 'ume' && artifact && [
    `ume await ${artifact} --turn-line --since {cursor}`,
    `ume await ${artifact} --since {cursor} --turn-line`,
  ].includes(wait.wait) ? artifact : undefined;
}
function localContext(cwd: string): { project?: string; cursors?: Record<string, number> } {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, '.ume', 'next.json'), 'utf8')) ?? {}; }
  catch { return {}; }
}
export function addUmeWatch(artifact: string, opts: { forId?: string; cwd?: string; project?: string; org?: string; cursor?: string; everySecs?: number } = {}): Watch {
  if (!ID.test(artifact)) throw new Error('watch add requires a ume artifact id');
  const key = `ume:${artifact}`;
  const existing = readWatch(key);
  const cwd = opts.cwd ?? process.cwd();
  const local = localContext(cwd);
  const project = opts.project ?? process.env.UME_PROJECT ?? local.project;
  return addWatch(key, `${watchSelfCommand()} watch check-ume ${artifact} --cursor {cursor}`, {
    owner: opts.forId ? `dispatch:${opts.forId}` : existing?.owner,
    cursor: opts.cursor ?? String(local.cursors?.[artifact] ?? 0), everySecs: opts.everySecs,
    context: { ...existing?.context, cwd: existing?.context?.cwd ?? cwd, env: { UME_URL: 'https://app.ume.so', ...(project ? { UME_PROJECT: project } : {}), ...existing?.context?.env }, org: existing?.context?.org ?? opts.org },
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
  } catch { return undefined; }
}
export function syncUmeWatches(): void {
  for (const lane of ['work', 'chore'] as Lane[]) for (const id of activeIds(lane)) {
    const entry = readStatusLog(id, lane).at(-1);
    if (entry) registerUmeReview(id, lane, entry, {});
  }
  clearFinishedUmeWatches();
}
export function clearFinishedUmeWatches(): void {
  for (const w of listWatches()) {
    if (!w.key.startsWith('ume:') || !w.owner.startsWith('dispatch:')) continue;
    const id = w.owner.slice('dispatch:'.length), lane = laneOf(id);
    const last = lane ? readStatusLog(id, lane).at(-1) : undefined;
    if (!lane || (last && TERMINAL_VERBS.includes(last.verb))) removeWatch(w.key);
  }
}
export type UmeRead = (args: string[], cwd?: string, project?: string) => unknown;
const readUme: UmeRead = (args, cwd, project) => {
  const res = spawnSync('ume', args, { cwd, env: { ...process.env, UME_URL: 'https://app.ume.so', UME_NO_BROWSER: '1', ...(project ? { UME_PROJECT: project } : {}) },
    shell: process.platform === 'win32', encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (res.error || res.status !== 0) throw new Error(res.stderr.trim() || res.error?.message || 'ume check failed');
  return JSON.parse(res.stdout);
};
/** The ume preset's check adapter: normal watch-contract JSON, like check-pr. */
export function runUmeCheck(artifact: string, cursor = '0', read: UmeRead = readUme): string {
  if (!ID.test(artifact) || !/^\d+$/.test(cursor)) throw new Error('watch check-ume requires an artifact id and numeric cursor');
  const w = readWatch(`ume:${artifact}`);
  const owner = w?.owner.startsWith('dispatch:') ? w.owner.slice('dispatch:'.length) : undefined;
  const lane = owner ? laneOf(owner) : undefined;
  const last = owner && lane ? readStatusLog(owner, lane).at(-1) : undefined;
  if (owner && (!lane || (last && TERMINAL_VERBS.includes(last.verb)))) return JSON.stringify({ cursor, events: [], done: true });
  const context = w?.context;
  let project = context?.env?.UME_PROJECT;
  if (w && (!project || !context?.org)) {
    const listing = read(['projects', '--json'], context?.cwd) as { current?: string; projects?: Array<{ project: string; org?: string }> };
    project ??= listing.current;
    const org = listing.projects?.find(p => p.project === project)?.org;
    if (project) {
      w.context = { ...context, env: { ...context?.env, UME_PROJECT: project }, org };
      updateWatch(w);
    }
  }
  const args = ['feedback', artifact, '--peek', '--since', cursor, '--json'];
  const missing = (e: unknown) => /no.such.artifact|no.such.project|no stored agent token reaches|agent_token_scope/.test(String(e));
  let data: unknown;
  try { data = read(args, context?.cwd, project); }
  catch (error) {
    if (!missing(error)) throw error;
    const listing = read(['projects', '--json'], context?.cwd) as { projects?: Array<{ project: string; org?: string }> };
    let found = false;
    for (const candidate of listing.projects ?? []) {
      if (!ID.test(candidate.project) || candidate.project === project) continue;
      try { data = read(args, context?.cwd, candidate.project); }
      catch (next) { if (!missing(next)) throw next; continue; }
      project = candidate.project;
      if (w) {
        w.context = { ...w.context, env: { ...context?.env, UME_PROJECT: project }, org: candidate.org };
        updateWatch(w);
      }
      found = true;
      break;
    }
    if (!found) throw error;
  }
  const result = data as { feedbackCount: number; batches?: Array<{ cursor: number; entries: Array<{ seq: number; kind: string }> }> };
  if (!result || typeof result.feedbackCount !== 'number' || (result.feedbackCount > 0 && !Array.isArray(result.batches))) throw new Error('ume returned invalid feedback');
  const batches = result.batches ?? [];
  const events = batches.flatMap(b => b.entries).filter(e => Number.isSafeInteger(e.seq) && e.seq > Number(cursor)).map(e => ({
    seq: e.seq, kind: e.kind,
    summary: `${e.kind}: ${project ? `set UME_PROJECT=${project}, then run ` : ''}ume feedback ${artifact} --since ${cursor}`,
  }));
  return JSON.stringify({ cursor: String(Math.max(Number(cursor), ...batches.map(b => b.cursor))), events });
}
