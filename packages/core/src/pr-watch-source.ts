import { spawnSync } from 'node:child_process';
import { PrWatchType, parseCommandWatchBatch, WatchCommandError } from '@lobstah/watch-types';
import type { PrWatchContext, PrWatchSnapshot, WatchFailure, WatchObservationBatch, WatchPresentation } from '@lobstah/watch-types';
import { classifyGhError, firstMeaningfulLine } from './gh-errors.js';
import { githubBlockedUntil, recordGitHubRateLimit } from './github-budget.js';
import type { PrBatchRun } from './pr-poll.js';
import { isPrPresetWatch, prBatchInFlight, preparePrWatchBatch } from './pr-poll.js';
import { listWatches } from './watch.js';
import { prFixBrief, prStandingKinds, prStateHash, prNote, parsePrRef } from './pr.js';
import { readPr } from './prs.js';
import { loadConfig } from './config.js';

/** Provider-wide limits are one incident; permission and identity errors remain per watch. */
function prWatchFailure(error: unknown): WatchFailure {
  const message = firstMeaningfulLine(error instanceof Error ? error.message : String(error)) ?? 'PR observation failed';
  const classified = classifyGhError(message);
  if (classified.kind === 'rate-limit') recordGitHubRateLimit();
  return {
    ...classified,
    message,
    ...(classified.kind === 'rate-limit' ? { shared: true } : {}),
    ...(error instanceof WatchCommandError && error.exitCode !== undefined ? { exitCode: error.exitCode } : {}),
  };
}

/** The shipped check remains a local transport for existing evidence and stack projections. */
function observePrWatch(context: PrWatchContext): WatchObservationBatch<string> {
  const { snapshot, now } = context;
  if (prBatchInFlight(snapshot.key)) return { cursor: snapshot.cursor, events: [], deferred: true };
  const blocked = githubBlockedUntil();
  if (blocked)
    return {
      cursor: snapshot.cursor,
      events: [],
      failure: {
        kind: 'rate-limit',
        message: `GitHub rate limit reached; retry after ${new Date(blocked).toISOString()}`,
        shared: true,
      },
    };
  const result = spawnSync(snapshot.options.check.replaceAll('{cursor}', snapshot.cursor), {
    shell: true,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, LOBSTAH_PR_BATCH: '1' },
  });
  if (result.status !== 0 || result.error) {
    const toonError = /^error:.*$/m.exec(result.stdout ?? '')?.[0];
    throw new WatchCommandError(
      result.error?.message || firstMeaningfulLine(toonError, result.stderr, result.stdout) || 'no output',
      result.status ?? undefined,
    );
  }
  const batch = parseCommandWatchBatch(result.stdout, snapshot.cursor, now);
  if (batch.failure) batch.failure = prWatchFailure(batch.failure.message);
  return batch;
}

/** Shared source presentation remains useful to a process that never loads the CLI presenter. */
function presentPrSnapshot(snapshot: PrWatchSnapshot): WatchPresentation {
  const config = loadConfig();
  const pr = readPr(snapshot.key),
    reference = snapshot.reference;
  return {
    title: pr?.title ?? snapshot.key,
    summary: snapshot.events.at(-1)?.summary ?? '',
    label: 'Pull request',
    tone: snapshot.failure && !snapshot.failure.shared ? 'risk' : 'neutral',
    worker: { steps: [snapshot.options.brief ?? prFixBrief(reference)] },
    helm: {
      steps: ['Read the pull request record, its checks and its owning chain before dispatching another repair.'],
      read: { executable: 'lobstah', args: ['prs'] },
    },
    rows: [
      { label: 'Pull request', value: reference.url },
      { label: 'State', value: pr?.state ?? 'unobserved' },
    ],
    links: [{ label: 'Open pull request', url: reference.url }],
    actions: [],
    attention: pr
      ? prStandingKinds(pr, { readySettleSecs: config.readySettleSecs, now: Date.parse(snapshot.checkedAt ?? snapshot.createdAt) }).map(
          (kind) => ({
            id: kind,
            kind,
            stateHash: prStateHash(pr),
            since: pr.standingSince[kind] ?? pr.observedAt,
            summary: prNote(pr, kind),
            quiet: false,
            blocking: false,
          }),
        )
      : [],
  };
}

/** Composition lives beside the source; the generic runtime has no GitHub branches. */
export function createPrWatchType(options: { run?: PrBatchRun } = {}): PrWatchType {
  return new PrWatchType({
    observe: observePrWatch,
    failure: prWatchFailure,
    present: presentPrSnapshot,
    batchObserver: {
      group: ({ snapshot }) => `${snapshot.reference.owner}/${snapshot.reference.repo}`,
      pollBatch(contexts) {
        const first = contexts[0];
        if (!first) return {};
        const { owner, repo } = first.snapshot.reference;
        const registered = listWatches().filter(
          (watch) => isPrPresetWatch(watch) && !watch.done && !['MERGED', 'CLOSED'].includes(readPr(watch.key)?.state ?? ''),
        );
        const repositoryCount = new Set([
          ...registered.map((watch) => {
            const reference = parsePrRef(watch.key)!;
            return `${reference.owner}/${reference.repo}`;
          }),
          `${owner}/${repo}`,
        ]).size;
        const peers = new Map(
          registered.filter((watch) => watch.key.startsWith(`pr:${owner}/${repo}#`)).map((watch) => [watch.key, watch]),
        );
        for (const { snapshot } of contexts)
          if (!peers.has(snapshot.key))
            peers.set(snapshot.key, {
              key: snapshot.key,
              check: snapshot.options.check,
              owner: 'man',
              cursor: snapshot.cursor,
              createdAt: snapshot.createdAt,
              seen: 0,
              seenAt: 0,
            });
        preparePrWatchBatch(first.everySecs ?? 45, Date.parse(first.now), { ...options, watches: [...peers.values()], repositoryCount });
        return Object.fromEntries(
          contexts.map((context) => {
            try {
              return [context.snapshot.key, observePrWatch(context)];
            } catch (error) {
              return [context.snapshot.key, { cursor: context.snapshot.cursor, events: [], failure: prWatchFailure(error) }];
            }
          }),
        );
      },
    },
  });
}
