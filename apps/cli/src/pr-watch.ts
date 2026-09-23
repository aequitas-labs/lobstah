import * as fs from 'node:fs';
import { parse } from 'smol-toml';
import {
  addWatch,
  COMPILED_BINARY,
  configPath,
  derivePrEvents,
  evidencePath,
  ghPrView,
  isFailingConclusion,
  listWatches,
  loadConfig,
  mergeEvidence,
  parsePrRef,
  postNotice,
  prEvidence,
  prFixBrief,
  readEvidence,
  readPr,
  readStatusLog,
  readWatch,
  upsertPr,
} from '@lobstah/core';
import type { GhPrView, Lane, PrEvent, PrRecord, PrRef, Watch } from '@lobstah/core';
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
 * One observation of a PR, written everywhere it belongs: the PR record
 * (always — man-owned or dispatch-owned, see core prs.ts), and the owning
 * dispatch's evidence when a dispatch owns the watch (its per-dispatch
 * view, merged, never clobbered). The open → merged/closed notice comes
 * from the record's transition — the one carrier for those two events
 * (docs/vocabulary.md) — so whoever observes first, pick's check or the
 * inline poller, announces it, and the previous state plus a dedupe key
 * keep it once-only. A PR with no record yet (observed before records
 * existed) falls back to the dispatch's previous evidence for that state.
 */
export function observePr(ref: PrRef, view: GhPrView, opts: { dispatchId?: string; now?: Date } = {}): PrRecord {
  const now = opts.now ?? new Date();
  const pr = prEvidence(ref, view, now.toISOString());
  const id = opts.dispatchId;
  const lane = id ? laneOf(id) : undefined;
  const legacyBefore = id && lane ? readEvidence(id, lane).pr : undefined;
  const { before, after } = upsertPr(pr, lane ? id : undefined);
  if (id && lane) mergeEvidence(id, lane, { pr });
  const was = before?.state ?? legacyBefore?.state;
  if (was === 'OPEN' && (pr.state === 'MERGED' || pr.state === 'CLOSED')) {
    const merged = pr.state === 'MERGED';
    const owner = after.dispatches.at(-1);
    const ownerLane = owner ? laneOf(owner) : undefined;
    postNotice({
      kind: merged ? 'pr-merged' : 'pr-closed',
      text: `${ref.key} ${merged ? 'merged' : 'closed without merge'} — ${owner ? `dispatch ${owner.slice(0, 8)}` : 'no dispatch (watched by the helm)'} (${ref.url})`,
      refId: owner ?? ref.key,
      ...(owner && ownerLane ? { repo: repoOf(owner, ownerLane) } : {}),
      dedupeKey: `${merged ? 'pr-merged' : 'pr-closed'}-${ref.key}-${view.mergedAt ?? view.closedAt ?? ''}`,
    });
  }
  return after;
}

/** The dispatch-owned observation, as #27 named it: record + that dispatch's evidence. */
export function stampPrEvidence(id: string, ref: PrRef, view: GhPrView, now = new Date()): void {
  if (!laneOf(id)) return; // culled owner — nothing to stamp (the record still comes from observePr callers)
  observePr(ref, view, { dispatchId: id, now });
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
 * Which derived events a man-owned watch delivers as attention — the
 * counterpart of workEvents (dispatch-owned) above: only what needs a
 * human. A failing check, and a review decision turning to changes
 * requested. Green checks, draft toggles, merge-state changes, and
 * approvals go to the PR record only; merged and closed reach the helm as
 * a notice from the record's transition (observePr), never also as a watch
 * event — one carrier per event kind.
 */
export function manEvents(events: PrEvent[]): PrEvent[] {
  return events.filter(
    (e) =>
      (e.kind === 'check-completed' && isFailingConclusion(e.conclusion)) ||
      (e.kind === 'review-decision' && e.value === 'CHANGES_REQUESTED'),
  );
}

/**
 * `lobstah watch check-pr <ref> [--for <uuid>] [--cursor <c>]`: one gh call,
 * the watch-contract JSON on stdout. Every run writes the PR record; with
 * --for it also stamps the owner's evidence and emits only work events
 * (workEvents); man-owned, only what needs a human (manEvents).
 */
export function runPrCheck(refArg: string, cursor: string | undefined, forId: string | undefined): string {
  const ref = parsePrRef(refArg);
  if (!ref) throw new Error(`not a PR reference: ${refArg} (want pr:<owner>/<repo>#<n> or a github.com PR URL)`);
  const view = ghPrView(ref);
  const out = derivePrEvents(ref, view, cursor);
  observePr(ref, view, { dispatchId: forId });
  const events = forId ? workEvents(ref, out.events) : manEvents(out.events);
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
    const seen = readPr(ref.key) ?? readEvidence(id, lane).pr;
    // A terminal PR has nothing left to observe; its watch retires when pick delivers.
    if (seen && (seen.state === 'MERGED' || seen.state === 'CLOSED')) continue;
    if (seen && now - Date.parse(seen.observedAt) < (w.everySecs ?? defaultEverySecs) * 1000) continue;
    try {
      observePr(ref, ghPrView(ref), { dispatchId: id, now: new Date(now) });
    } catch {
      // gh missing or unauthenticated: pick's real check records lastError
    }
  }
}
