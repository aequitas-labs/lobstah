import { randomUUID } from 'node:crypto';
import {
  builtinWatchRegistry,
  mergeRequestAuthority,
  readPr,
  readPrs,
  stackMergeRevision,
  WatchAutomationRunner,
  WatchRuntime,
} from '@lobstah/core';
import type { PrMergeWatchServices, StackWatchServices } from '@lobstah/watch-types';
import { reconcileRequestedPrs, reconcileRequestedStacks } from '../pr-merge.js';
import type { PrMergeDeps, StackMergeDeps } from '../pr-merge.js';

/** Standing human requests authorize source actions; readiness alone never grants authority. */
export function prMergeWatchServices(
  log: (message: string) => void,
  deps: PrMergeDeps = {},
): Pick<PrMergeWatchServices, 'automation' | 'effectHandler'> {
  return {
    automation: {
      propose({ snapshot }) {
        const record = readPr(snapshot.reference.key),
          request = record?.mergeRequest;
        const authority = mergeRequestAuthority(snapshot.reference.key, request);
        return record && request && authority
          ? [
              {
                actionId: 'advance',
                authority,
                by: request.by,
                authorizedAt: request.at,
                expectedRevision: record.headSha,
                idempotencyKey: randomUUID(),
                arguments: {},
              },
            ]
          : [];
      },
    },
    effectHandler: {
      execution: 'sync',
      execute(action) {
        const record = readPr(action.reference.key),
          request = record?.mergeRequest;
        if (
          action.actionId !== 'advance' ||
          !record ||
          !request ||
          mergeRequestAuthority(record.key, request) !== action.authorization.id ||
          request.by !== action.authorization.by ||
          request.at !== action.authorization.at ||
          record.headSha !== action.expectedRevision
        )
          throw new Error('Merge authorization or checked head changed');
        reconcileRequestedPrs(log, {
          ...deps,
          keys: [record.key],
          expectedHead: action.expectedRevision,
          authority: action.authorization.id,
          dispatchId: action.id,
        });
        return { workIds: [] };
      },
    },
  };
}

/** Every stack member head and the exact recorded request scope fence the remote operation. */
export function stackMergeWatchServices(
  log: (message: string) => void,
  deps: StackMergeDeps = {},
): Pick<StackWatchServices, 'automation' | 'effectHandler'> {
  return {
    automation: {
      propose({ snapshot }) {
        const root = readPr(snapshot.reference.rootKey),
          request = root?.stackMergeRequest;
        const authority = mergeRequestAuthority(snapshot.reference.rootKey, request);
        return root && request && authority
          ? [
              {
                actionId: 'advance',
                authority,
                by: request.by,
                authorizedAt: request.at,
                expectedRevision: stackMergeRevision(root, readPrs()),
                idempotencyKey: randomUUID(),
                arguments: {},
              },
            ]
          : [];
      },
    },
    effectHandler: {
      execution: 'sync',
      execute(action) {
        const root = readPr(action.reference.rootKey),
          request = root?.stackMergeRequest;
        if (
          action.actionId !== 'advance' ||
          !root ||
          !request ||
          mergeRequestAuthority(root.key, request) !== action.authorization.id ||
          request.by !== action.authorization.by ||
          request.at !== action.authorization.at ||
          stackMergeRevision(root, readPrs()) !== action.expectedRevision
        )
          throw new Error('Stack merge authorization or member heads changed');
        reconcileRequestedStacks(log, {
          ...deps,
          keys: [root.key],
          expectedRevision: action.expectedRevision,
          authority: action.authorization.id,
          dispatchId: action.id,
        });
        return { workIds: [] };
      },
    },
  };
}

/** Merge scheduling is separate from the capped repair pass, preserving the standing-request cadence. */
export function deliverMergeWatchActions(
  log: (message: string) => void,
  options: { pr?: PrMergeDeps; stack?: StackMergeDeps },
  now = Date.now(),
): void {
  const records = readPrs();
  const registry = builtinWatchRegistry({
    ...(options.pr ? { prMerge: prMergeWatchServices(log, { ...options.pr, records }) } : {}),
    ...(options.stack ? { stack: stackMergeWatchServices(log, options.stack) } : {}),
  });
  const runtime = new WatchRuntime(registry),
    keys: string[] = [];
  for (const record of readPrs()) {
    const registrations = [
      ...(options.pr && record.mergeRequest ? [{ type: 'pr-merge', input: record.key, key: record.key.replace(/^pr:/, 'pr-merge:') }] : []),
      ...(options.stack && record.stackMergeRequest ? [{ type: 'stack', input: `stack:${record.key}`, key: `stack:${record.key}` }] : []),
    ];
    for (const item of registrations) {
      const prior = runtime.journal.read(item.key);
      if (!prior || prior.status === 'retired') runtime.register(item.type, item.input, {}, { kind: 'helm', grounds: 'home' });
      runtime.checkSync(item.key, { now, everySecs: 0 });
      keys.push(item.key);
    }
  }
  new WatchAutomationRunner(registry, runtime.journal).runSync(keys, now, Number.MAX_SAFE_INTEGER, log);
  for (const key of keys) runtime.checkSync(key, { now, everySecs: 0 });
}
