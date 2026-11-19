import { parsePrRef, prFixBrief, readWatch, prTodoTriggers, readPr, upsertPr, prEvidence, ghPrViewDirect } from '@lobstah/core';
import type { WatchRegistrationPolicy } from '@lobstah/watch-types';
import { prCheckCommand } from '../pr-watch.js';
import { prWatchEffects } from '../pr-watch-effects.js';
import { legacyRegistration, registerLegacyWatch } from './legacy.js';
import { lobstahHome } from '@lobstah/core';
import { createPrQuestionWatch } from '../pr-questions.js';

const questions = new Map<string, ReturnType<typeof createPrQuestionWatch>>();

/** Compatibility policy belongs to the adapter, including its scheduled side effects. */
export function prRegistration(log: (message: string) => void): WatchRegistrationPolicy {
  return {
    prepare(request) {
      if (request.event !== 'explicit' || typeof request.fields.key !== 'string') return undefined;
      const ref = parsePrRef(request.fields.key);
      if (!ref) return undefined;
      const existing = readWatch(ref.key);
      return legacyRegistration(
        {
          ...existing,
          key: ref.key,
          check: prCheckCommand(ref, request.owner.kind === 'dispatch' ? request.owner.chainId : undefined),
          owner: existing?.owner ?? 'man',
          brief: request.owner.kind === 'dispatch' ? prFixBrief(ref) : existing?.brief,
          cursor: existing?.cursor ?? '0',
          createdAt: existing?.createdAt ?? '1970-01-01T00:00:00.000Z',
          seen: existing?.seen ?? 0,
          seenAt: existing?.seenAt ?? 0,
        },
        request.options,
      );
    },
    registered: registerLegacyWatch,
    sync(now, phase) {
      if (phase === 'before-observe') {
        const home = lobstahHome();
        if (!questions.has(home)) questions.set(home, createPrQuestionWatch());
        questions.get(home)!(Date.parse(now), log);
      }
      if (phase === 'after-observe') prWatchEffects(Date.parse(now), log);
    },
  };
}

/** Provider refresh and todo instructions stay with the adapter. */
export function prTriggerServices() {
  return { ...prTodoTriggers(), prepare({ key }: { key: string; on: string }) {
    const reference = parsePrRef(key)!;
    if (readWatch(key) && readPr(key)) return;
    try { upsertPr(prEvidence(reference, ghPrViewDirect(reference), new Date().toISOString())); }
    catch (error) { throw new Error(`GitHub can't read ${key}: ${error instanceof Error ? error.message : String(error)}`); }
  } };
}
