import { prTendQueries } from './pr-tend.js';
import { cutPrTitle, dispatchPrUrls, listWatches, prBadge, prNewestFirst, readPr, readPrs, toonKV, toonTable } from '@lobstah/core';
import type { Evidence, GlassDispatch, TrapRegistration } from '@lobstah/core';
import { probeTrapPr } from '../beat-pr.js';
import type { WatchProbeRun } from '../watch-command.js';
import { prGlassProjection } from './pr-glass.js';
import { readPrDetails } from '../pr-details.js';
import fs from 'node:fs';
import { loadConfig, parsePrRef, readEvidence, readSessionClaim, storedDescriptor, mergeEvidence } from '@lobstah/core';
import type { Lane, StatusEntry, Watch } from '@lobstah/core';
import type { WatchCommandPolicy } from '@lobstah/watch-types';
import { autoRegisterPrWatch, registerWharfPrWatch, refreshMissingDispatchPrs } from '../pr-watch.js';
import { dispatchPrDiscovery, recordDispatchPrs } from '../pr-stack.js';
import { holdCancelledRepair, liveRepairer, repairChores, waitingRepairs, recordPushFailure, recordReportedGates } from '../pr-repair.js';
import { registerWaitWatches, waitWarning } from '../pr-waits.js';
import { trapPrWaitAsDone } from '../trap-pr-wait.js';
import { publishDispatchQuestions } from '../pr-questions.js';
import { briefPrMentions, resolvePrTarget } from '../pr-target.js';
import { mergeWhenGreenCommand } from '../pr-merge-command.js';

/** Legacy report and diagnostic operations follow the installed source's command contract. */
interface HostInputs {
  'report.prepare': { id: string; lane: Lane; verb: string; waiting: { waitingOn?: string; link?: string }; references: string[] };
  'report.record': {
    id: string;
    lane: Lane;
    entry: StatusEntry;
    references: string[];
    gates: string[];
    enabled: boolean;
    permission: boolean;
  };
  'dispatch.target': { repo: string; reference: string };
  'dispatch.advice': { repo: string; brief: string };
  'trap.beat': { registration: TrapRegistration; now?: number };
  'dispatch.cancelled': { id: string };
  'glass.snapshot': { rows: GlassDispatch[]; shared: GlassDispatch[]; watches: Watch[] };
  'glass.details': { key: string };
  'catch.fields': { evidence: Evidence };
  'catch.details': { evidence: Evidence };
  'watch.resolve': { reference: string };
  'watch.import': { reference: string };
  'watch.refresh': Record<string, never>;
  'repair.health': { now?: number };
}

export function prHostCommands(compatibility: WatchCommandPolicy, run?: WatchProbeRun): WatchCommandPolicy {
  const host: { [K in keyof HostInputs]: (input: HostInputs[K]) => unknown } = {
    'report.prepare': ({ id, lane, verb, waiting, references }) => trapPrWaitAsDone(id, lane, verb, waiting, references) ?? null,
    'report.record': async ({
      id,
      lane,
      entry,
      references,
      gates,
      enabled,
      permission,
    }: {
      id: string;
      lane: Lane;
      entry: StatusEntry;
      references: string[];
      gates: string[];
      enabled: boolean;
      permission: boolean;
    }) => {
      if (entry.verb === 'failed') recordPushFailure(id, lane, entry.note);
      const primary = references[0];
      let urls: string[] = [];
      if (primary) {
        const evidence = readEvidence(id, lane);
        const worktree = readSessionClaim(id, lane)?.worktree ?? evidence.worktree;
        const branches = [...new Set([evidence.branch, ...(evidence.pushes ?? []).map((push) => push.branch)])].filter(
          (branch): branch is string => !!branch && branch !== 'HEAD',
        );
        const discovery = dispatchPrDiscovery(references, {
          cwd: worktree && fs.existsSync(worktree) ? worktree : process.cwd(),
          branches,
        });
        urls = discovery.urls;
        if (urls.length) recordDispatchPrs(id, lane, discovery, false);
        else mergeEvidence(id, lane, { prUrl: primary });
      }
      const humanGates = recordReportedGates(id, lane, gates, primary);
      const warnings: string[] = [];
      if (entry.verb === 'needs-decision' && !permission) {
        try {
          await publishDispatchQuestions(id, lane);
        } catch (error) {
          warnings.push(`PR question delivery will retry: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const watches =
        entry.verb !== 'failed' && primary && enabled && !storedDescriptor(id, lane)?.systemRepair
          ? urls.map((url) => autoRegisterPrWatch(id, url)).filter((watch): watch is Watch => !!watch)
          : entry.verb === 'paused' && enabled
            ? registerWaitWatches(id, lane, entry)
            : [];
      const warning = waitWarning(id, lane, entry);
      if (warning) warnings.push(warning);
      return {
        fields: {
          ...(primary ? { prUrl: primary } : {}),
          ...(urls.length > 1 ? { prs: urls.join(', ') } : {}),
          ...(watches.length ? { watch: watches.map((watch) => watch.key).join(', ') } : {}),
          ...(humanGates.length ? { humanGates: humanGates.join(', ') } : {}),
        },
        warnings,
      };
    },
    'dispatch.target': ({ repo, reference }) => resolvePrTarget(repo, reference),
    'dispatch.advice': ({ repo, brief }) =>
      briefPrMentions(brief, repo).map(
        (url) =>
          `the brief names ${url}, but this dispatch will open its own draft PR; to push to that PR instead, dispatch with --pr ${url}`,
      ),
    'trap.beat': ({ registration, now }) => probeTrapPr(registration, { now, run }),
    'dispatch.cancelled': ({ id }) => holdCancelledRepair(id),
    'glass.snapshot': ({ rows, watches, shared }) => prGlassProjection(rows, watches, shared),
    'glass.details': ({ key }) => readPrDetails(key),
    'catch.fields': ({ evidence: ev }) =>
      dispatchPrUrls(ev).length > 1
        ? {
            prs: dispatchPrUrls(ev)
              .map((url) => {
                const record = readPr(parsePrRef(url)!.key);
                return record ? `${prBadge(record).text} ${url}` : url;
              })
              .join('; '),
          }
        : {},
    'catch.details': ({ evidence }) => catchDetails(evidence),
    'watch.resolve': ({ reference }) => parsePrRef(reference)?.key ?? reference,
    'watch.import': ({ reference }) => registerWharfPrWatch(reference) ?? null,
    'watch.refresh': () => {
      refreshMissingDispatchPrs();
      return null;
    },
    'repair.health': ({ now }) => ({ live: liveRepairer(now) ?? null, chores: repairChores(), waiting: waitingRepairs() }),
  };
  const handlers = { ...host, ...prTendQueries };
  return {
    bindings: [...compatibility.bindings, ...Object.keys(handlers).map((name) => ({ name })), { name: 'pr' }, { name: 'prs' }],
    run(request) {
      if (request.name === 'pr')
        return mergeWhenGreenCommand(request.args, {
          opt: (name) => (typeof request.flags[name] === 'string' ? (request.flags[name] as string) : undefined),
          has: (name) => request.flags[name] !== undefined,
        });
      if (request.name === 'prs') return listPrs();
      const handler = handlers[request.name as keyof typeof handlers] as ((input: unknown) => unknown) | undefined;
      if (!handler) return compatibility.run(request);
      const result = handler(JSON.parse(request.args[0] ?? '{}'));
      return result instanceof Promise ? result.then((value) => JSON.stringify(value ?? null)) : JSON.stringify(result ?? null);
    },
  };
}

function catchDetails(ev: Evidence): string | null {
  if (ev.pr) {
    const c = ev.pr.checks;
    return toonKV({
      pr: prBadge(ev.pr).text,
      prState: ev.pr.state,
      prDraft: ev.pr.draft,
      prReview: ev.pr.reviewDecision || 'none',
      ...(ev.pr.review
        ? {
            prChangesRequested: ev.pr.review.changesRequested,
            ...(ev.pr.review.unresolvedThreads !== undefined ? { prUnresolvedThreads: ev.pr.review.unresolvedThreads } : {}),
            ...(ev.pr.review.lastReviewAt ? { prLastReviewAt: ev.pr.review.lastReviewAt } : {}),
          }
        : {}),
      prMergeState: ev.pr.mergeStateStatus,
      prHead: ev.pr.headSha,
      prChecks: `${c.passed}/${c.total} passed, ${c.failed} failed, ${c.pending} pending`,
      prObservedAt: ev.pr.observedAt,
    });
  }
  return null;
}

function listPrs(): string {
  const now = Date.now();
  const watches = new Map(listWatches().map((w) => [w.key, w]));
  const records = readPrs();
  const rows = records.sort(prNewestFirst(records));
  return toonTable(
    'prs',
    rows.map((r) => {
      const watch = watches.get(r.key);
      const ageMins = Math.max(0, Math.floor((now - Date.parse(r.observedAt)) / 60_000));
      return {
        number: `#${r.number}`,
        title: cutPrTitle(r.title),
        repo: r.repo,
        state: r.state,
        badge: prBadge(r).text,
        draft: r.draft,
        checks: `${r.checks.passed}/${r.checks.total} passed, ${r.checks.failed} failed, ${r.checks.pending} pending`,
        observed: Number.isFinite(ageMins) ? `${ageMins}m ago` : 'unknown',
        watch: watch ? (watch.lastError ? 'error' : watch.done ? 'done' : 'watching') : 'no watch',
      };
    }),
    ['number', 'title', 'repo', 'state', 'badge', 'draft', 'checks', 'observed', 'watch'],
  );
}
