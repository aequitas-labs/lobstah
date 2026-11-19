import { PrMergeRefused, cancelPrMerge, cancelStackMerge, requestPrMerge, requestStackMerge } from '../pr-merge.js';
import type { WatchCommandPolicy } from '@lobstah/watch-types';
import { loadConfig, syncStackReadiness } from '@lobstah/core';
import type { WatchRegistrationPolicy } from '@lobstah/watch-types';
import { deliverMergeWatchActions } from '../watch-sources/merge.js';

const prepare: WatchRegistrationPolicy['prepare'] = (request) =>
  request.event === 'explicit' && typeof request.fields.key === 'string'
    ? { input: request.fields.key, options: request.options }
    : undefined;

/** Each authorization source owns its lifecycle independently of the observation source. */
export function mergeRegistration(log: (message: string) => void): WatchRegistrationPolicy {
  return {
    prepare,
    sync(now, phase) {
      if (phase === 'after-observe') deliverMergeWatchActions(log, { pr: {} }, Date.parse(now));
    },
  };
}

export function stackRegistration(log: (message: string) => void): WatchRegistrationPolicy {
  return {
    prepare,
    sync(now, phase) {
      if (phase !== 'after-observe') return;
      syncStackReadiness(loadConfig(), Date.parse(now));
      deliverMergeWatchActions(log, { stack: {} }, Date.parse(now));
    },
  };
}

/** The provider validates its compatibility HTTP action before recording authority. */
export function mergeCommands(stack: boolean): WatchCommandPolicy {
  const name = stack ? 'glass.stack-merge' : 'glass.pr-merge';
  return {
    bindings: [{ name }],
    run(request) {
      const { payload, by } = JSON.parse(request.args[0] ?? '{}');
      const key = stack ? payload?.stack : payload?.key;
      const field = stack ? 'stack' : 'key';
      const result = (status: number, body: unknown) => JSON.stringify({ status, body });
      if (typeof key !== 'string' || !/^pr:[^\s]{1,300}$/.test(key))
        return result(400, { ok: false, reason: stack ? 'A stack is required.' : 'A PR key is required.' });
      if (payload?.cancel === true) {
        const cancelled = stack ? cancelStackMerge(key) : cancelPrMerge(key);
        if (cancelled === 'merging') return result(409, { ok: false, reason: "GitHub is already merging it, so it can't be cancelled." });
        return result(200, { ok: true, [field]: key, cancelled: cancelled === true || cancelled === 'cancelled' });
      }
      try {
        const recorded = stack ? requestStackMerge(key, by) : requestPrMerge(key, by);
        return result(200, { ok: true, [field]: key, method: recorded.method });
      } catch (error) {
        return result(error instanceof PrMergeRefused ? error.status : 500, {
          ok: false,
          reason: error instanceof PrMergeRefused ? error.message : 'The merge request could not be stored.',
        });
      }
    },
  };
}
