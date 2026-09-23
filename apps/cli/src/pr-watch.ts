import * as fs from 'node:fs';
import { parse } from 'smol-toml';
import {
  addWatch,
  COMPILED_BINARY,
  configPath,
  derivePrEvents,
  evidencePath,
  ghPrView,
  listWatches,
  loadConfig,
  mergeEvidence,
  parsePrRef,
  postNotice,
  prEvidence,
  prFixBrief,
  readEvidence,
  readStatusLog,
  readWatch,
} from '@lobstah/core';
import type { GhPrView, Lane, PrEvent, PrRef, Watch } from '@lobstah/core';
import { githubRepoFromOrigin } from '@lobstah/pick';
import { repoOf } from './digest.js';

/**
 * The CLI half of the `pr:` watch preset (the pure half is core's pr.ts):
 * the check subcommand, auto-registration from `report done --pr`, evidence
 * stamping, and observe-only polling for the inline poller.
 *
 * Pick stays the single writer of dispatch-owned watch progress: only a
 * real check run (pick's watch loop, or `man wait` for a man-owned watch)
 * advances a cursor and appends events. The inline poller only observes —
 * it stamps the owner's evidence and never touches the watch.
 */

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** How this process re-invokes itself from a shell — node layout or compiled binary. */
function selfCommand(): string {
  if (COMPILED_BINARY) return shq(process.execPath);
  const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : 'lobstah';
  return `${shq(process.execPath)} ${shq(entry)}`;
}

/** The shipped check command for a PR watch; `{cursor}` is the watch's own placeholder. */
export function prCheckCommand(ref: PrRef, forId?: string): string {
  return `${selfCommand()} watch check-pr ${shq(ref.key)}${forId ? ` --for ${shq(forId)}` : ''} --cursor {cursor}`;
}

/** Sugar over addWatch: install the shipped check (and the fix brief when a chain owns it). */
export function addPrWatch(ref: PrRef, opts: { forId?: string; everySecs?: number } = {}): Watch {
  return addWatch(ref.key, prCheckCommand(ref, opts.forId), {
    owner: opts.forId ? `dispatch:${opts.forId}` : 'man',
    everySecs: opts.everySecs,
    brief: opts.forId ? prFixBrief(ref) : undefined,
  });
}

/**
 * `report done --pr <url>` registers the PR's watch, owned by the reporting
 * dispatch's chain. Idempotent: an existing watch for the PR (a continuation
 * re-reporting the same PR, or a hand-registered one) is left alone. A URL
 * that is not a GitHub PR registers nothing. Never throws — a done report
 * must not fail over observation.
 */
export function autoRegisterPrWatch(id: string, prUrl: string): Watch | undefined {
  try {
    const ref = parsePrRef(prUrl);
    if (!ref || readWatch(ref.key)) return undefined;
    return addPrWatch(ref, { forId: id });
  } catch {
    return undefined;
  }
}

function laneOf(id: string): Lane | undefined {
  return (['work', 'chore'] as Lane[]).find((l) => fs.existsSync(evidencePath(id, l)) || readStatusLog(id, l).length > 0);
}

/**
 * Stamp the owner's evidence `pr` object (merge, never clobber), and on the
 * open → merged/closed transition post the helm notice once. The notice
 * comes from the evidence transition, not from watch events, so whoever
 * observes first — pick's check or the inline poller — announces it, and
 * the previous evidence state plus a dedupe key keep it once-only.
 */
export function stampPrEvidence(id: string, ref: PrRef, view: GhPrView, now = new Date()): void {
  const lane = laneOf(id);
  if (!lane) return; // culled owner — nothing to stamp
  const before = readEvidence(id, lane).pr;
  const pr = prEvidence(ref, view, now.toISOString());
  mergeEvidence(id, lane, { pr });
  if (before?.state === 'OPEN' && (pr.state === 'MERGED' || pr.state === 'CLOSED')) {
    const merged = pr.state === 'MERGED';
    postNotice({
      kind: merged ? 'pr-merged' : 'pr-closed',
      text: `${ref.key} ${merged ? 'merged' : 'closed without merge'} — dispatch ${id.slice(0, 8)} (${ref.url})`,
      refId: id,
      repo: repoOf(id, lane),
      dedupeKey: `${merged ? 'pr-merged' : 'pr-closed'}-${ref.key}-${view.mergedAt ?? view.closedAt ?? ''}`,
    });
  }
}

function rawConfig(): Record<string, unknown> {
  try {
    return parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Whether pickup's feedback rule owns review feedback for this forge repo —
 * docs/pickup.md "Feedback pickup". When it does, a review-decision event
 * must not fork a continuation too, or one review would dispatch twice.
 * Read from the raw file: loadPickupConfig resolves tokens, which a check
 * must not need.
 */
export function pickupOwnsReviewFeedback(forgeRepo: string): boolean {
  const gh = ((rawConfig().pickup ?? {}) as Record<string, unknown>).github as Record<string, unknown> | undefined;
  if (!gh) return false;
  if (gh.repo || gh.key) return String(gh.repo ?? '') === forgeRepo;
  return Object.values(loadConfig().repos).some(
    (r) => r.pickup === true && r.origin !== undefined && githubRepoFromOrigin(r.origin) === forgeRepo,
  );
}

/**
 * Which derived events a dispatch-owned watch emits: only work. A failing
 * check always; a review decision unless pickup owns review feedback. Green
 * checks, draft, merge state, merged, and closed are evidence (merged and
 * closed also a notice) — never a continuation.
 */
export function workEvents(ref: PrRef, events: PrEvent[], pickupOwnsReview = pickupOwnsReviewFeedback(`${ref.owner}/${ref.repo}`)): PrEvent[] {
  return events.filter((e) => !e.notice && (e.kind !== 'review-decision' || !pickupOwnsReview));
}

/**
 * `lobstah watch check-pr <ref> [--for <uuid>] [--cursor <c>]`: one gh call,
 * the watch-contract JSON on stdout. With --for it stamps the owner's
 * evidence and emits only work events; man-owned, it emits every event.
 */
export function runPrCheck(refArg: string, cursor: string | undefined, forId: string | undefined): string {
  const ref = parsePrRef(refArg);
  if (!ref) throw new Error(`not a PR reference: ${refArg} (want pr:<owner>/<repo>#<n> or a github.com PR URL)`);
  const view = ghPrView(ref);
  const out = derivePrEvents(ref, view, cursor);
  if (forId) stampPrEvidence(forId, ref, view);
  const events = forId ? workEvents(ref, out.events) : out.events;
  return JSON.stringify({ cursor: out.cursor, events, ...(out.done ? { done: true } : {}) });
}

/** Poll cadence: [pickup].pollSecs, the same default as pick's. */
export function pollSecs(): number {
  const n = Number(((rawConfig().pickup ?? {}) as Record<string, unknown>).pollSecs ?? 45);
  return Number.isFinite(n) && n > 0 ? n : 45;
}

/**
 * The inline poller's observe-only pass over dispatch-owned PR watches:
 * with no pick running, the helm park and `man wait` still keep PR state
 * badges fresh and announce merges. It never stamps lastCheckedAt, never
 * advances a cursor, never appends events — pick sees and forks every
 * event exactly as if this pass had not run. Cadence rides the evidence's
 * own observedAt, which pick's check stamps too, so the two share one
 * gh call per PR per cycle.
 */
export function observeDispatchPrWatches(defaultEverySecs = pollSecs(), now = Date.now()): void {
  for (const w of listWatches()) {
    if (!w.key.startsWith('pr:') || !w.owner.startsWith('dispatch:') || w.done) continue;
    const id = w.owner.slice('dispatch:'.length);
    const ref = parsePrRef(w.key);
    const lane = laneOf(id);
    if (!ref || !lane) continue;
    const seen = readEvidence(id, lane).pr;
    // A terminal PR has nothing left to observe; its watch retires when pick delivers.
    if (seen && (seen.state === 'MERGED' || seen.state === 'CLOSED')) continue;
    if (seen && now - Date.parse(seen.observedAt) < (w.everySecs ?? defaultEverySecs) * 1000) continue;
    try {
      stampPrEvidence(id, ref, ghPrView(ref), new Date(now));
    } catch {
      // gh missing or unauthenticated: pick's real check records lastError
    }
  }
}
