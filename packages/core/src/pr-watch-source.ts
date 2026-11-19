import { prAcknowledgements } from './pr-acknowledgements.js';
import { prTodoTriggers } from './pr-todo.js';
import { spawnSync } from 'node:child_process';
import { PrWatchType } from '@lobstah/watch-types/pr';
import { CommandWatchType, parseCommandWatchBatch, WatchCommandError } from '@lobstah/watch-types';
import type { PrWatchServices } from '@lobstah/watch-types/pr';
import { prDispatchPolicy } from './pr-watch-delivery.js';
import type { PrWatchContext, PrWatchSnapshot } from '@lobstah/watch-types/pr';
import type { WatchFailure, WatchObservationBatch, WatchPresentation } from '@lobstah/watch-types';
import { classifyGhError, firstMeaningfulLine } from './gh-errors.js';
import { githubBlockedUntil, recordGitHubRateLimit } from './github-budget.js';
import type { PrBatchRun } from './pr-poll.js';
import { isPrPresetWatch, prBatchInFlight, preparePrWatchBatch } from './pr-poll.js';
import { listWatches } from './watch.js';
import { prFixBrief, prStandingKinds, prStateHash, prNote, parsePrRef } from './pr.js';
import { readPr } from './prs.js';
import { readWatch } from './watch.js';
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
  if (!isPrPresetWatch({ key: snapshot.key, check: snapshot.options.check })) {
    const batch = new CommandWatchType().poll({ ...context, snapshot: { ...snapshot, state: {} } });
    if (batch.failure) batch.failure = prWatchFailure(batch.failure.message);
    return batch;
  }
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
      steps: ['Read the pull request record, its checks and its owning chain before dispatching another repair.', 'A human approval check starts no repair. Each failing check gets one repair round per PR head; read any supplied hold, settle period or cooldown before starting another round.', 'A repair pushes only its PR branch. On a non-fast-forward rejection, fetch the moved branch and retry with the source’s bounded push policy; report a blocked push and leave the PR when the bound is exhausted.'],
      read: { executable: 'lobstah', args: ['prs'] },
    },
    rows: [
      { label: 'Pull request', value: reference.url },
      { label: 'State', value: pr?.state ?? 'unobserved' },
    ],
    links: [{ label: 'Open pull request', url: reference.url }],
    actions: [{ id: 'repair', label: 'Schedule repair', requiresAuthority: true, automatic: true }],
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
export interface PrWatchSourceOptions {
  acknowledgements?: PrWatchServices['acknowledgements'];
  triggers?: PrWatchServices['triggers'];
  commands?: PrWatchServices['commands'];
  registration?: PrWatchServices['registration'];
  run?: PrBatchRun;
  effectHandler?: PrWatchServices['effectHandler'];
  automation?: PrWatchServices['automation'];
  present?: PrWatchServices['present'];
}

export function createPrWatchType(options: PrWatchSourceOptions = {}): PrWatchType {
  return new PrWatchType({
    acknowledgements: options.acknowledgements ?? prAcknowledgements(),
    triggers: options.triggers ?? prTodoTriggers(),
    commands: options.commands,
    registration: options.registration,
    noticePolicy: { kinds: [], current: () => true, relatedDispatches(notice) {
      const ids: string[] = [];
      for (const value of [notice.refId, notice.url]) {
        const reference = value ? parsePrRef(value) : undefined;
        if (!reference) continue;
        const owner = readWatch(reference.key)?.owner;
        if (owner?.startsWith('dispatch:')) ids.push(owner.slice(9));
        ids.push(...(readPr(reference.key)?.dispatches ?? []).slice().reverse());
      }
      return ids;
    } },
    observe: observePrWatch,
    effectHandler: options.effectHandler,
    automation: options.automation,
    dispatchPolicy: prDispatchPolicy(),
    failure: prWatchFailure,
    present: options.present ?? presentPrSnapshot,
    batchObserver: {
      group: ({ snapshot }) =>
        `${isPrPresetWatch({ key: snapshot.key, check: snapshot.options.check }) ? 'github' : 'command'}:${snapshot.reference.owner}/${snapshot.reference.repo}`,
      pollBatch(contexts) {
        const first = contexts[0];
        if (!first) return {};
        if (!isPrPresetWatch({ key: first.snapshot.key, check: first.snapshot.options.check }))
          return Object.fromEntries(
            contexts.map((context) => {
              try {
                return [context.snapshot.key, observePrWatch(context)];
              } catch (error) {
                return [context.snapshot.key, { cursor: context.snapshot.cursor, events: [], failure: prWatchFailure(error) }];
              }
            }),
          );
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
