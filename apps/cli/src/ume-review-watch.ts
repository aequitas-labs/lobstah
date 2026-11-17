import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  activeIds, addWatch, appendWatchEvents, laneOf, listTraps, listWatches, lobstahTurnSessions,
  markWatchSeen, readSessionClaim, readStatusLog, readTurnWaits, readWatch, readWatchEvents,
  recordWatchFailure, recordWatchSuccess, removeWatch, sendMessage, setWatchCursor,
  TERMINAL_VERBS, updateWatch, watchDue, watchFailureLogLine,
  type Lane, type StatusEntry, type Watch, type TurnWaitRegistration,
} from '@lobstah/core';

const ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function umeArtifact(text: string): string | undefined {
  return /https:\/\/app\.ume\.so\/a\/([A-Za-z0-9_-]+)(?=[\s/?#),.]|$)/.exec(text)?.[1];
}
export function umeReadArtifact(read: string): string | undefined {
  const id = /^ume feedback ([A-Za-z0-9_-]+)(?:\s|$)/.exec(read)?.[1];
  return id && ARTIFACT.test(id) ? id : undefined;
}
/** Only ume's shipped turn-line registration is replaced; custom waits keep their command. */
export function isUmeReviewWait(wait: TurnWaitRegistration): boolean {
  const artifact = umeReadArtifact(wait.read);
  return wait.from === 'ume' && !!artifact && [
    `ume await ${artifact} --turn-line --since {cursor}`,
    `ume await ${artifact} --since {cursor} --turn-line`,
  ].includes(wait.wait);
}
function localContext(cwd: string): { project?: string; cursors?: Record<string, number> } {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, '.ume', 'next.json'), 'utf8')); }
  catch { return {}; }
}
function register(id: string, artifact: string, cwd: string, project?: string, cursor?: string): Watch {
  const existing = readWatch(`ume:${id}:${artifact}`);
  if (existing?.umeReview) return existing;
  const local = localContext(cwd);
  return addWatch(`ume:${id}:${artifact}`, `ume feedback ${artifact} --peek --json`, {
    owner: `dispatch:${id}`, cursor: String(Math.max(
      /^\d+$/.test(cursor ?? '') ? Number(cursor) : 0,
      Number.isSafeInteger(local.cursors?.[artifact]) ? local.cursors![artifact] : 0,
    )),
    umeReview: { artifact, cwd, project: project ?? local.project ?? undefined },
  });
}
/** Register at report time, while the command's project environment is still available. */
export function registerUmeReview(id: string, lane: Lane, entry: StatusEntry, env = process.env): Watch | undefined {
  if (entry.verb !== 'paused') return undefined;
  const artifact = umeArtifact(`${entry.link ?? ''} ${entry.note ?? ''}`);
  const claim = readSessionClaim(id, lane);
  if (!artifact || !claim?.worktree) return undefined;
  return register(id, artifact, claim.worktree, env.UME_PROJECT);
}
/** Recover existing parks, including registrations written without a paused report. */
export function syncUmeReviews(dispatchForWait?: (key: string) => string | undefined): void {
  const traps = new Map(listTraps().map(t => [t.sessionId, t]));
  for (const session of lobstahTurnSessions()) for (const wait of readTurnWaits(session)) {
    const trap = traps.get(session);
    const artifact = isUmeReviewWait(wait) ? umeReadArtifact(wait.read) : undefined;
    const dispatch = dispatchForWait?.(wait.key) ?? trap?.claimed;
    if (!artifact || !dispatch || !trap) continue;
    const lane = laneOf(dispatch);
    if (!lane || dispatchEnded(dispatch, lane)) continue;
    register(dispatch, artifact, wait.cwd ?? trap.cwd, undefined, wait.cursor);
  }
  for (const lane of ['work', 'chore'] as Lane[]) for (const id of activeIds(lane)) {
    const entry = readStatusLog(id, lane).at(-1);
    if (entry) registerUmeReview(id, lane, entry, {});
  }
  clearFinishedUmeReviews();
}
function dispatchEnded(id: string, lane: Lane): boolean {
  const last = readStatusLog(id, lane).at(-1);
  return !!last && TERMINAL_VERBS.includes(last.verb);
}
export function clearFinishedUmeReviews(): void {
  for (const w of listWatches()) {
    if (!w.umeReview) continue;
    const id = w.owner.slice('dispatch:'.length);
    const lane = laneOf(id);
    if (!lane || dispatchEnded(id, lane)) removeWatch(w.key);
  }
}

export type UmeRead = (args: string[], cwd: string, project?: string) => Promise<unknown>;
const readUme: UmeRead = (args, cwd, project) => new Promise((resolve, reject) => {
  // ume selects the narrowest stored token for this project, including other organizations.
  const env = { ...process.env, UME_URL: 'https://app.ume.so', UME_NO_BROWSER: '1', ...(project ? { UME_PROJECT: project } : {}) };
  execFile('ume', args, { cwd, env, shell: process.platform === 'win32', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) { reject(new Error(stderr.trim() || error.message)); return; }
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('ume returned invalid JSON')); }
  });
});
interface Feedback { feedbackCount: number; batches?: Array<{ cursor: number; entries: Array<{ seq: number; kind: string }> }> }
function feedback(value: unknown): Feedback {
  const result = value as Feedback;
  if (!result || typeof result.feedbackCount !== 'number' || (result.feedbackCount > 0 && !Array.isArray(result.batches))) throw new Error('ume returned invalid feedback');
  return result;
}
/** The first lookup uses the captured project; legacy parks can locate their artifact across accessible orgs. */
async function poll(w: Watch, read: UmeRead): Promise<{ data: Feedback; project?: string }> {
  const context = w.umeReview!;
  if (!/^\d+$/.test(w.cursor)) throw new Error('invalid ume feedback cursor');
  const args = ['feedback', context.artifact, '--peek', '--since', w.cursor, '--json'];
  try { return { data: feedback(await read(args, context.cwd, context.project)), project: context.project }; }
  catch (error) {
    if (!/no.such.artifact|no.such.project|no stored agent token reaches|agent_token_scope/.test(String(error))) throw error;
    const listing = await read(['projects', '--json'], context.cwd) as { projects?: Array<{ project: string }> };
    for (const { project } of listing.projects ?? []) {
      if (!/^[A-Za-z0-9_-]+$/.test(project) || project === context.project) continue;
      try { return { data: feedback(await read(args, context.cwd, project)), project }; }
      catch (next) {
        if (!/no.such.artifact|no.such.project|no stored agent token reaches|agent_token_scope/.test(String(next))) throw next;
      }
    }
    throw error;
  }
}
/** Poll without consuming ume's read cursor; inbox delivery uses the existing hooked and hookless wake paths. */
export function createUmeReviewWatch(read: UmeRead = readUme,
  onDelivery?: (watch: Watch, lane: Lane, file: string, at: number) => void,
  dispatchForWait?: (key: string) => string | undefined) {
  let running = false;
  return (now: number, log: (message: string) => void): Promise<void> | undefined => {
    if (running) return undefined;
    running = true;
    return (async () => {
      syncUmeReviews(dispatchForWait);
      for (const w of listWatches()) {
        if (!w.umeReview || !watchDue(w, 15, now)) continue;
        w.lastCheckedAt = new Date(now).toISOString();
        if (!updateWatch(w)) continue;
        try {
          const { data, project } = await poll(w, read);
          // A finished dispatch or removed watch must not receive an in-flight response.
          clearFinishedUmeReviews();
          if (readWatch(w.key)?.createdAt !== w.createdAt) continue;
          w.umeReview.project = project;
          recordWatchSuccess(w);
          updateWatch(w);
          const batches = data.batches ?? [];
          const events = batches.flatMap(b => b.entries).filter(e => Number.isSafeInteger(e.seq) && e.seq > Number(w.cursor));
          appendWatchEvents(w.key, events.map(e => ({ seq: e.seq, kind: e.kind, at: new Date(now).toISOString() })));
          const pending = readWatchEvents(w.key).slice(w.seen);
          if (pending.length) {
            const id = w.owner.slice('dispatch:'.length);
            const lane = laneOf(id);
            if (!lane) continue;
            const command = `ume feedback ${w.umeReview.artifact} --since ${w.cursor}`;
            const file = sendMessage(id, lane, `ume has new review feedback: https://app.ume.so/a/${w.umeReview.artifact}. ${project ? `Set UME_PROJECT to ${project}, then run` : 'Run'} \`${command}\` to read it.`, 'wait:ume');
            onDelivery?.(w, lane, file, now);
            markWatchSeen(w.key);
            log(`watch ${w.key}: review feedback delivered to ${id}`);
          }
          const cursor = Math.max(Number(w.cursor), ...batches.map(b => b.cursor));
          if (Number.isSafeInteger(cursor)) setWatchCursor(w.key, String(cursor));
        } catch (error) {
          recordWatchFailure(w, error instanceof Error ? error.message : String(error), undefined, new Date(now));
          updateWatch(w);
          log(watchFailureLogLine(w));
        }
      }
    })().catch(error => log(`ume review watch failed, will retry: ${String(error)}`)).finally(() => { running = false; });
  };
}
