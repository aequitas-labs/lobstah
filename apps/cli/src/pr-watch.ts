import * as fs from 'node:fs';
import { parse } from 'smol-toml';
import {
  addWatch,
  COMPILED_BINARY,
  configPath,
  derivePrEvents,
  evidencePath,
  ghPrTitle,
  ghPrView,
  isFailingConclusion,
  laneDirs,
  listWatches,
  loadConfig,
  mergeEvidence,
  parsePrRef,
  pendingIds,
  queuedDescriptor,
  cancelQueued,
  postNotice,
  prEvidence,
  prFixBrief,
  readEvidence,
  readPr,
  readPrs,
  readStatusLog,
  readWatch,
  removeWatch,
  runWatchCheck,
  setPrTitle,
  storedDescriptor,
  upsertPr,
  watchDue,
  syncStackReadiness,
  preparePrWatchBatch,
} from '@lobstah/core';
import type { GhPrView, Lane, PrEvent, PrRecord, PrRef, Watch, PrBatchRun } from '@lobstah/core';
import { githubRepoFromOrigin } from '@lobstah/pick';
import { repoOf } from './digest.js';
import { discoverPrStack } from './pr-stack-watch.js';

/**
 * The CLI half of the `pr:` watch preset (the pure half is core's pr.ts):
 * the check subcommand, auto-registration from `report --pr` and the trap beat, evidence
 * stamping, and observe-only polling for the inline poller.
 *
 * The daemon batches all PR watches even without pickup or a helm. Pickup
 * and inline helm polling reuse the same repository cycle. Each check
 * still advances its own cursor, stamps its owner's evidence, and retires
 * a terminal PR watch; auto-repair remains the daemon's responsibility.
 */

const shq = (s: string) => (process.platform === 'win32' ? `"${s.replaceAll('"', '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`);

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
 * `report --pr <url>` and the trap beat register the PR's watch, owned by
 * the reporting dispatch's chain. Idempotent: an existing watch for the PR (a continuation
 * re-reporting the same PR, or a hand-registered one) is left alone. A URL
 * that is not a GitHub PR registers nothing. Never throws — a report
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

/** One PR the backfill would register, retire, or give a title. */
export interface BackfillRow {
  key: string;
  action: 'register' | 'retire' | 'title';
  owner: string;
  /** Why an applied title fetch failed. */
  error?: string;
}

/**
 * `lobstah watch backfill`: find PRs in dispatch history that have no watch,
 * and PR records that have no title. This is an explicit migration command.
 * No read command calls it. Without `apply` it only lists what it would do.
 * With `apply` it registers a watch for each PR not known to be terminal,
 * removes the watch of a PR known to be MERGED or CLOSED, and fetches the
 * title of each record without one (one `gh pr view --json title` per
 * record; the only GitHub call backfill makes). A PR record takes precedence
 * over older dispatch evidence when deciding terminal state. A new watch
 * starts at cursor "0", so its first check is a baseline and forks nothing
 * (derivePrEvents).
 */
export function backfillPrWatches(opts: { apply?: boolean; fetchTitle?: (ref: PrRef) => string } = {}): BackfillRow[] {
  const apply = opts.apply === true;
  const fetchTitle = opts.fetchTitle ?? ghPrTitle;
  const rows: BackfillRow[] = [];
  type Member = { id: string; followUp?: string; at: string };
  const members = new Map<string, Member>();
  const known = new Map<string, { terminal?: boolean; observedAt?: string; ids: Set<string> }>();
  const add = (url: string | undefined, id?: string, terminal?: boolean, observedAt?: string) => {
    const ref = url && parsePrRef(url);
    if (!ref) return;
    const row = known.get(ref.key) ?? { ids: new Set<string>() };
    if (id) row.ids.add(id);
    if (terminal !== undefined && (!row.observedAt || (observedAt ?? '') > row.observedAt)) {
      row.terminal = terminal;
      row.observedAt = observedAt;
    }
    known.set(ref.key, row);
  };
  const records = readPrs();
  const recordKeys = new Set(records.map((r) => r.key));
  for (const r of records) {
    add(r.url, undefined, r.state === 'MERGED' || r.state === 'CLOSED', r.observedAt);
    for (const id of r.dispatches) add(r.url, id);
  }
  for (const lane of ['work', 'chore'] as Lane[]) {
    const dirs = laneDirs(lane);
    for (const bucket of ['active', 'done'] as const) {
      let ids: string[];
      try {
        ids = fs.readdirSync(dirs[bucket]).filter((id) => !id.startsWith('.'));
      } catch {
        continue;
      }
      for (const id of ids) {
        const descriptor = storedDescriptor(id, lane);
        const at = readStatusLog(id, lane).at(-1)?.at ?? '';
        members.set(id, { id, followUp: descriptor?.followUp, at });
      }
    }
    let files: string[];
    try {
      files = fs.readdirSync(dirs.state).filter((f) => f.endsWith('.evidence'));
    } catch {
      continue;
    }
    for (const file of files) {
      const id = file.slice(0, -'.evidence'.length);
      const ev = readEvidence(id, lane);
      add(ev.prUrl, id);
      if (ev.pr) {
        const ref = parsePrRef(ev.pr.url);
        add(
          ev.pr.url,
          id,
          ref && !recordKeys.has(ref.key) ? ev.pr.state === 'MERGED' || ev.pr.state === 'CLOSED' : undefined,
          ev.pr.observedAt,
        );
      }
    }
  }
  for (const [key, row] of known) {
    if (row.terminal) {
      const existing = readWatch(key);
      if (existing) {
        rows.push({ key, action: 'retire', owner: existing.owner });
        if (apply) removeWatch(key);
      }
      continue;
    }
    if (readWatch(key)) continue;
    const ref = parsePrRef(key)!;
    // Follow the newest live member of any dispatch chain that named this PR.
    // Keep culled ancestors in the seed set: a surviving follow-up can still
    // point at one of them even though the ancestor's descriptor is gone.
    const chain = new Set(row.ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const member of members.values()) {
        if (member.followUp && chain.has(member.followUp) && !chain.has(member.id)) {
          chain.add(member.id);
          changed = true;
        }
      }
    }
    const owner = [...chain]
      .map((id) => members.get(id))
      .filter((m): m is Member => m !== undefined)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0];
    rows.push({ key, action: 'register', owner: owner ? `dispatch:${owner.id}` : 'man' });
    if (apply) addPrWatch(ref, owner ? { forId: owner.id } : {});
  }
  for (const r of records) {
    if (r.title) continue;
    const ref = parsePrRef(r.key);
    if (!ref) continue;
    const row: BackfillRow = { key: r.key, action: 'title', owner: readWatch(r.key)?.owner ?? '' };
    if (apply) {
      try {
        setPrTitle(r.key, fetchTitle(ref));
      } catch (err) {
        row.error = (err as Error).message;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Refresh each due PR watch at most once. Registers nothing. */
export function syncPrWatches(at = Date.now(), opts: { run?: PrBatchRun } = {}): { refreshed: number } {
  let refreshed = 0;
  const every = pollSecs();
  const now = new Date(at);
  preparePrWatchBatch(every, at, opts);
  for (const w of listWatches()) {
    if (!w.key.startsWith('pr:') || !watchDue(w, every, now.getTime())) continue;
    const before = readPr(w.key)?.observedAt;
    const { watch } = runWatchCheck(w, now);
    const after = readPr(w.key)?.observedAt;
    if (!watch.lastError && after && after !== before) refreshed++;
    if (watch.done) removeWatch(w.key);
  }
  syncStackReadiness(loadConfig(), at);
  return { refreshed };
}

function laneOf(id: string): Lane | undefined {
  return (['work', 'chore'] as Lane[]).find((l) => fs.existsSync(evidencePath(id, l)) || readStatusLog(id, l).length > 0);
}

/** A first observation of a terminal PR posts a notice only when it ended this recently. */
export const FIRST_SIGHT_NOTICE_MS = 24 * 60 * 60 * 1000;

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
 * A PR seen for the first time already MERGED or CLOSED gets at most one
 * notice, and none when it ended more than 24 hours ago.
 */
export function observePr(ref: PrRef, view: GhPrView, opts: { dispatchId?: string; now?: Date; discovered?: boolean } = {}): PrRecord {
  const now = opts.now ?? new Date();
  const pr = prEvidence(ref, view, now.toISOString());
  pr.discoveryPending = opts.discovered ? true : undefined;
  const id = opts.dispatchId;
  const lane = id ? laneOf(id) : undefined;
  const ev = id && lane ? readEvidence(id, lane) : undefined;
  const legacyBefore = ev?.pr && parsePrRef(ev.pr.url)?.key === ref.key ? ev.pr : undefined;
  const { before, after } = upsertPr(pr, lane ? id : undefined);
  // A dispatch with several PRs keeps its first PR's state in `pr`; the others live in their records.
  const other = ev?.prUrls?.some((u) => parsePrRef(u)?.key === ref.key) && parsePrRef(ev.prUrl ?? '')?.key !== ref.key;
  if (id && lane && !other) mergeEvidence(id, lane, { pr });
  const was = before?.state ?? legacyBefore?.state;
  const terminal = pr.state === 'MERGED' || pr.state === 'CLOSED';
  // A merged or closed PR has nothing to repair: repairs still queued for it are cancelled.
  if (terminal) cancelQueuedRepairs(ref.key);
  // First sight of a terminal PR: announce only when it ended in the last 24 hours.
  const endedAt = Date.parse(view.mergedAt ?? view.closedAt ?? '');
  const recentEnd = Number.isFinite(endedAt) && now.getTime() - endedAt <= FIRST_SIGHT_NOTICE_MS;
  if (terminal && (was === 'OPEN' || (was === undefined && recentEnd))) {
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

/**
 * Cancel the repair chores still queued for a PR (by its `owner/repo#n`
 * key): each finalizes as cancelled before claim. A claimed repair re-checks
 * the PR itself before it starts. Returns the cancelled ids.
 */
export function cancelQueuedRepairs(key: string): string[] {
  const cancelled: string[] = [];
  for (const id of pendingIds('chore')) {
    const d = queuedDescriptor(id, 'chore');
    if (!d?.systemRepair || !d.pr?.url || parsePrRef(d.pr.url)?.key !== key) continue;
    if (cancelQueued(id, 'chore')) cancelled.push(id);
  }
  return cancelled;
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
export function workEvents(
  ref: PrRef,
  events: PrEvent[],
  pickupOwnsReview = pickupOwnsReviewFeedback(`${ref.owner}/${ref.repo}`),
): PrEvent[] {
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
  discoverPrStack(ref, { everySecs: readWatch(ref.key)?.everySecs });
  syncStackReadiness();
  const events = forId ? workEvents(ref, out.events) : manEvents(out.events);
  // Degraded view (no permission to read checks): the state is recorded and
  // the cursor advances, and the watch still records the permission error.
  const error = view.checksError ? `${view.checksError} (reading check results; checks unknown, PR state recorded)` : undefined;
  return JSON.stringify({ cursor: out.cursor, events, ...(out.done ? { done: true } : {}), ...(error ? { error } : {}) });
}

/** Poll cadence: [pickup].pollSecs, the same default as pick's. */
export function pollSecs(): number {
  const n = Number(((rawConfig().pickup ?? {}) as Record<string, unknown>).pollSecs ?? 45);
  return Number.isFinite(n) && n > 0 ? n : 45;
}

/**
 * The daemon's pass over dispatch-owned PR watches. It keeps state badges
 * and merge notices current without pickup or a helm. It does not advance
 * a watch cursor or append events. When auto-repair is off, pickup may still
 * check these watches; observedAt shares the cadence between the two.
 */
export function observeDispatchPrWatches(defaultEverySecs = pollSecs(), now = Date.now(), view: (ref: PrRef) => GhPrView = ghPrView): void {
  for (const w of listWatches()) {
    if (!w.key.startsWith('pr:') || !w.owner.startsWith('dispatch:') || w.done) continue;
    const id = w.owner.slice('dispatch:'.length);
    const ref = parsePrRef(w.key);
    const lane = laneOf(id);
    if (!ref || !lane) continue;
    // The dispatch's `pr` evidence is one PR's observation: it stands in only
    // for that PR. A dispatch with several PRs has one watch per PR.
    const own = readEvidence(id, lane).pr;
    const seen = readPr(ref.key) ?? (own && parsePrRef(own.url)?.key === ref.key ? own : undefined);
    // A terminal PR has nothing left to observe; pick's check retires its watch.
    if (seen && (seen.state === 'MERGED' || seen.state === 'CLOSED')) continue;
    if (seen && now - Date.parse(seen.observedAt) < (w.everySecs ?? defaultEverySecs) * 1000) continue;
    // A failing watch backs off (core watch.ts); the observe-only pass must not poll around it.
    if (w.failures && !watchDue(w, defaultEverySecs, now)) continue;
    try {
      const record = observePr(ref, view(ref), { dispatchId: id, now: new Date(now) });
      if (record.state === 'OPEN') discoverPrStack(ref, { now, everySecs: w.everySecs ?? defaultEverySecs });
      if (record.state === 'MERGED' || record.state === 'CLOSED') removeWatch(w.key);
    } catch {
      // gh missing, unauthenticated, or forbidden: pick's real check records the streak
    }
  }
  syncStackReadiness(loadConfig(), now);
}

/** A PR title for `lobstah prs`: at most `max` characters, the last an ellipsis when cut; '' when absent. */
export function cutTitle(title: string | undefined, max = 60): string {
  const chars = Array.from((title ?? '').replace(/\s+/g, ' ').trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}
