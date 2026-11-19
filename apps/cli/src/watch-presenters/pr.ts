import fs from 'node:fs';
import path from 'node:path';
import {
  prFixBrief,
  prNote,
  prStandingKinds,
  prBadge,
  queuedDescriptor,
  laneDirs,
  readStatusLog,
  readTrap,
  trapRepoLabel,
  readEvidence,
  readPr,
  readPrs,
  parsePrRef,
  derivePrStacks,
  identifyPrStacks,
  readStackEpochs,
  readWatch,
  humanGatesFor,
  matchesGate,
  repoKey as forgeRepoKey,
} from '@lobstah/core';
import type { Config, Lane, PrEvidence, TendAttention, TendAttentionKind, Watch, WatchPresentation } from '@lobstah/core';
import { readPickupMap } from '@lobstah/pick';
import { prStateHash } from '../acks.js';
import { liveRepairer } from '../pr-repair.js';

/** Legacy PR/stack presentation stays source-owned during the adapter cutover. */
export interface ChainMember {
  id: string;
  bucket: 'queued' | 'active' | 'done';
}

/**
 * The on-the-hook rule, pure: a pr:review or pr:checks item is suppressed
 * while a worker owns the problem — a queued or active dispatch in the PR's
 * chain that is a pickup feedback round (pickup's own map records it as
 * kind `review`) or the pr: watch's fix continuation (the watch records it
 * as lastFollowUpId). Returns the owning dispatch id, or undefined. When
 * that dispatch finishes without clearing the condition, the item stands
 * again. Every other kind is never suppressed.
 */
export function onTheHook(
  kind: TendAttentionKind,
  chain: ChainMember[],
  owners: { reviewRounds: ReadonlySet<string>; watchFollowUp?: string },
): string | undefined {
  if (kind !== 'pr:review' && kind !== 'pr:checks') return undefined;
  return chain.find((m) => m.bucket !== 'done' && (owners.reviewRounds.has(m.id) || m.id === owners.watchFollowUp))?.id;
}

/** Which pr:* kinds a PR's evidence stands on right now. Pure. */
export const prKinds = prStandingKinds;

const PR_KIND_NOTE: Record<string, (pr: PrEvidence) => string> = {
  'pr:draft': (pr) => prNote(pr, 'draft'),
  'pr:review': (pr) =>
    prNote(
      pr,
      `review: ${[
        pr.review?.unresolvedThreads ? `${pr.review.unresolvedThreads} unresolved` : '',
        pr.review?.changesRequested ? 'changes requested' : '',
      ]
        .filter(Boolean)
        .join(', ')}`,
    ),
  'pr:checks': (pr) => prNote(pr, `checks ${pr.checks.failed}/${pr.checks.total} failed`),
  'pr:conflict': (pr) => prNote(pr, `conflicts with ${pr.baseRefName ?? 'its base'}`),
  'pr:ready': (pr) => prNote(pr, 'ready to merge'),
};

/** Hide a repairable problem only after a live repairer has claimed safe work. */
export function humanPrAttention(
  pr: PrEvidence,
  kind: TendAttentionKind,
  cfg: Config,
  watchAvailable = true,
  now = Date.now(),
): { show: boolean; reason?: string } {
  if (kind !== 'pr:conflict' && kind !== 'pr:checks' && kind !== 'pr:review') return { show: true };
  const repairableReview = kind === 'pr:review' && pr.review?.changesRequested === true;
  if (kind === 'pr:review' && !repairableReview) return { show: true }; // unresolved question for a person
  const enabled = cfg.watch.autoRepair && (kind !== 'pr:conflict' || cfg.watch.conflicts) && (kind !== 'pr:checks' || cfg.watch.checks);
  if (!enabled) return { show: true, reason: 'auto-repair is off' };
  const owned = 'dispatches' in pr && Array.isArray(pr.dispatches) && pr.dispatches.length > 0;
  if (!owned) return { show: true, reason: 'not owned by lobstah' };
  const matchingRepair =
    pr.repair?.headSha === pr.headSha &&
    pr.repair.kind === (kind === 'pr:review' ? 'review' : kind === 'pr:conflict' ? 'conflict' : 'checks');
  if (matchingRepair && (pr.repair!.status === 'blocked' || pr.repair!.status === 'gave-up'))
    return { show: true, reason: pr.repair!.reason };
  if (!watchAvailable) return { show: true, reason: 'no active PR watch' };
  if (!liveRepairer(now)) return { show: true, reason: 'no repairer is running' };
  // A check that had its round at this head and still fails needs a person.
  if (matchingRepair && pr.repair!.status === 'waiting' && pr.repair!.heldBy === 'repaired')
    return { show: true, reason: pr.repair!.reason };
  // A waiting repair needs no person: it is shown in the repairs-waiting table instead.
  if (matchingRepair && pr.repair!.status === 'waiting') return { show: false, reason: `repair waits: ${pr.repair!.reason ?? ''}` };
  if (!matchingRepair || pr.repair?.status !== 'repairing' || !pr.repair.dispatchId)
    return { show: true, reason: 'repair not yet claimed' };
  const queued = queuedDescriptor(pr.repair.dispatchId, 'work');
  const active = fs.existsSync(path.join(laneDirs('work').active, pr.repair.dispatchId));
  const last = readStatusLog(pr.repair.dispatchId, 'work').at(-1)?.verb;
  if ((!queued && !active) || last === 'done' || last === 'failed') return { show: true, reason: 'repair awaiting next observation' };
  if (queued?.for?.startsWith('wt:')) {
    const trap = readTrap(queued.for.slice(3));
    if (!trap || !!trap.claimed || !trap.firstParkedAt || now - Date.parse(trap.heartbeatAt) > cfg.soak.deferSecs * 1000) {
      return { show: true, reason: `trap ${trap ? trapRepoLabel(trap) : queued.for} not listening` };
    }
  }
  return { show: false };
}

/** Dispatch evidence `pr` objects, newest per PR url — the legacy source. */
export function evidencePrs(): Array<{ id: string; lane: Lane; pr: PrEvidence }> {
  const newest = new Map<string, { id: string; lane: Lane; pr: PrEvidence }>();
  for (const lane of ['work', 'chore'] as Lane[]) {
    let files: string[];
    try {
      files = fs.readdirSync(laneDirs(lane).state).filter((f) => f.endsWith('.evidence'));
    } catch {
      continue;
    }
    for (const f of files) {
      const id = f.slice(0, -'.evidence'.length);
      const evidence = readEvidence(id, lane);
      const pr = evidence.pr;
      if (!pr) continue;
      if ((evidence.prUrls?.length ?? 0) > 1 && !readPr(parsePrRef(pr.url)?.key ?? pr.url)?.state) continue;
      const prev = newest.get(pr.url);
      if (!prev || prev.pr.observedAt < pr.observedAt) newest.set(pr.url, { id, lane, pr });
    }
  }
  return [...newest.values()];
}

const dispatchLane = (id: string): Lane | undefined =>
  (['work', 'chore'] as Lane[]).find((l) => fs.existsSync(path.join(laneDirs(l).state, `${id}.status`)));

/**
 * Observed PRs — the pr: watch's observations, never a forge call. Read
 * order: PR records first (core prs.ts: every observation, man-owned or
 * dispatch-owned), then dispatch evidence for a PR with no record yet. A
 * record attaches to its newest dispatch still on disk; one with none (a
 * human's PR, or a culled chain) is keyed by the PR itself: no chain, so
 * nothing puts it on the hook.
 */
export function observedPrs(
  records = readPrs(),
  legacy = evidencePrs(),
): Array<{ id: string; lane: Lane; pr: PrEvidence; dispatch: boolean }> {
  const out: Array<{ id: string; lane: Lane; pr: PrEvidence; dispatch: boolean }> = [];
  const seen = new Set<string>();
  for (const r of records) {
    seen.add(r.url);
    const owner = [...r.dispatches].reverse().find((id) => dispatchLane(id) !== undefined);
    out.push(
      owner ? { id: owner, lane: dispatchLane(owner)!, pr: r, dispatch: true } : { id: r.key, lane: 'work', pr: r, dispatch: false },
    );
  }
  for (const e of legacy) if (!seen.has(e.pr.url)) out.push({ ...e, dispatch: true });
  return out;
}

/** Adapter ports keep dispatch graph traversal outside source policy. */
export interface PrAttentionGraph {
  chainOf(id: string): ChainMember[];
  repoOf(id: string, lane: Lane): string | undefined;
}

export function prAttention(now: number, observed: ReturnType<typeof observedPrs>, cfg: Config, graph: PrAttentionGraph): TendAttention[] {
  const reviewRounds = new Set(
    Object.values(readPickupMap())
      .filter((e) => e.kind === 'review')
      .map((e) => e.uuid),
  );
  const out: TendAttention[] = [];
  const stacks = identifyPrStacks(
    derivePrStacks(
      observed.map((x) => x.pr),
      {
        readySettleSecs: cfg.readySettleSecs,
        now,
      },
    ),
  );
  for (const { id, lane, pr, dispatch } of observed) {
    const kinds = prKinds(pr, { readySettleSecs: cfg.readySettleSecs, now });
    if (kinds.length === 0) continue;
    const ref = parsePrRef(pr.url);
    const prWatch = ref ? readWatch(ref.key) : undefined;
    const watchFollowUp = prWatch?.lastFollowUpId;
    const chain = dispatch ? graph.chainOf(id) : [];
    for (const kind of kinds) {
      if (kind === 'pr:checks' && stacks.some((s) => s.members.some((p) => p.url === pr.url))) {
        const gates = ['Approval Gate', ...humanGatesFor(readPr(pr.url), ref ? forgeRepoKey(cfg, `${ref.owner}/${ref.repo}`) : undefined)];
        if (pr.failingChecks?.length === pr.checks.failed && pr.failingChecks.every((c) => matchesGate(c.name, gates))) continue;
      }
      // Pickup owns a submitted-review round before any repair continuation exists.
      if (kind === 'pr:review' && onTheHook(kind, chain, { reviewRounds })) continue;
      const human = humanPrAttention(pr, kind, cfg, !!prWatch && !prWatch.done, now);
      if (!human.show) continue;
      const repairCannotAct =
        human.reason !== undefined && !['auto-repair is off', 'not owned by lobstah', 'no active PR watch'].includes(human.reason);
      if (!repairCannotAct && onTheHook(kind, chain, { reviewRounds, watchFollowUp })) continue;
      // Older dispatch evidence has no record; its observation is the best
      // available approximation until a PR record is written.
      const conditionSince = pr.standingSince?.[kind] ?? pr.observedAt;
      const standingSince =
        kind === 'pr:ready' ? new Date(Date.parse(conditionSince) + cfg.readySettleSecs * 1000).toISOString() : conditionSince;
      out.push({
        kind,
        key: ref?.key ?? pr.url,
        stateHash: prStateHash(pr),
        id,
        lane,
        verb: kind,
        ageSecs: Math.max(0, Math.round((now - Date.parse(standingSince)) / 1000)),
        at: standingSince,
        standingSince,
        note: `${PR_KIND_NOTE[kind]!(pr)}${human.reason ? ` — ${human.reason}` : ''}`,
        repo: dispatch ? graph.repoOf(id, lane) : ref ? `${ref.owner}/${ref.repo}` : undefined,
        prUrl: pr.url,
        number: pr.number,
        state: pr.state,
        draft: pr.draft,
        reviewDecision: pr.reviewDecision,
        mergeStateStatus: pr.mergeStateStatus,
        headSha: pr.headSha,
        checks: pr.checks,
        ...(pr.review ? { review: pr.review } : {}),
      });
    }
  }
  return out;
}

/** The PR adapter owns its operating instructions, including the stack and repair rules. */
export function presentPrWatch(watch: Watch): WatchPresentation | undefined {
  const reference = parsePrRef(watch.key);
  if (!reference) return undefined;
  const record = readPr(reference.key);
  return {
    title: record?.title ?? `PR #${reference.number}`,
    summary: record ? prNote(record, prBadge(record).text) : watch.key,
    label: 'PR',
    tone: record?.checks.failed ? 'risk' : 'neutral',
    worker: { steps: [prFixBrief(reference)] },
    helm: {
      steps: [
        `Read the observed state of ${reference.key} before acting; tend and the glass do not refresh GitHub.`,
        'A stack has one persistent readiness item, with members in bottom-first merge order and a link to its current top PR. Growth or a transition back to ready can wake it again; bottom-first merges keep the same item.',
        'Repairs wait for live branch owners, settle periods, cooldowns and watch holds. Read the supplied waiting reason before assigning another repair.',
        'Human approval checks never start repairs. A check gets one repair round per head; a repair that stops without merge progress needs a person after the configured limit.',
        'A repair cancellation holds its watch. Use watch release only when the work is safe to resume. Headless repairs never use a live trap checkout.',
        'Report a finished repair with its PR. Its watch owns the next review or CI round; the worker does not park on its own PR.',
      ],
    },
    rows: [{ label: 'PR', value: reference.key }, ...(record ? [{ label: 'State', value: prBadge(record).text }] : [])],
    links: [{ label: 'Open PR', url: record?.url ?? `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}` }],
    actions: [],
    attention: [],
  };
}
