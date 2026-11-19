import { humanGatesFor, matchesGate } from './pr-repair.js';
import { isFailingConclusion } from './pr.js';
import { readPr } from './prs.js';
import { loadConfig } from './config.js';
import { storedDescriptor } from './queue.js';
import { laneOf } from './worktrees.js';
import { withBriefHooks } from './config.js';
import { journalWatchViews } from './watch-presentation.js';
import { WatchJournal } from './watch-journal.js';
import { readWatch, recordCheckRounds, checkRoundKey } from './watch.js';
import type { Watch, WatchEvent } from './watch.js';
import type { PrWatchReference, WatchDispatchPolicy } from '@lobstah/watch-types';
import type { PrWatchState, CommandWatchOptions } from '@lobstah/watch-types';

/** Existing check-round and human-gate policy belongs to the PR source. */
export function ciFixWork(w: Watch, events: WatchEvent[]): { work: WatchEvent[]; rounds: string[]; skipped: string[] } {
  if (!w.key.startsWith('pr:') || !w.owner.startsWith('dispatch:')) return { work: events, rounds: [], skipped: [] };
  const owner = w.owner.slice('dispatch:'.length);
  const ownerLane = laneOf(owner);
  const repo = ownerLane ? storedDescriptor(owner, ownerLane)?.repo : undefined;
  const gates = humanGatesFor(readPr(w.key), repo, [owner, ...(w.lastFollowUpId ? [w.lastFollowUpId] : [])]);
  const done = new Set(w.checkRounds ?? []);
  const rounds: string[] = [];
  const skipped: string[] = [];
  const work = events.filter((e) => {
    if (e.kind !== 'check-completed' || !isFailingConclusion(e.conclusion as string | undefined) || typeof e.name !== 'string') return true;
    if (matchesGate(e.name, gates)) {
      skipped.push(`${e.name} (human gate)`);
      return false;
    }
    const round = checkRoundKey(String(e.headSha ?? ''), e.name);
    if (done.has(round)) {
      skipped.push(`${e.name} (had its round at ${String(e.headSha ?? '').slice(0, 7)})`);
      return false;
    }
    done.add(round);
    rounds.push(round);
    return true;
  });
  return { work, rounds, skipped };
}

/** PR policy consumes managed events and supplies source-specific worker hooks. */
export function prDispatchPolicy(): WatchDispatchPolicy<PrWatchReference, PrWatchState, string, CommandWatchOptions> {
  return {
    plan(context) {
      const legacy = readWatch(context.snapshot.key);
      const view = legacy ?? journalWatchViews().find((entry) => entry.snapshot.key === context.snapshot.key)?.watch;
      if (!view) return { disposition: 'ignore', eventIds: [], notes: [] };
      const watch: Watch = {
        ...view,
        checkRounds: [...new Set([...(context.snapshot.state.checkRounds ?? []), ...(legacy?.checkRounds ?? [])])],
      };
      if (loadConfig().watch.autoRepair && readPr(watch.key)) return { disposition: 'managed', eventIds: [], notes: [] };
      const events: WatchEvent[] = context.events.map((event) => ({
        ...(event.data as Record<string, unknown>),
        seq: event.id,
        summary: event.summary,
        at: event.at,
      }));
      const result = ciFixWork(watch, events);
      return {
        disposition: result.work.length ? 'continue' : 'ignore',
        eventIds: result.work.map((event) => String(event.seq)),
        notes: result.skipped,
        state: { rounds: result.rounds },
      };
    },
    prepareBrief(context, filled) {
      return withBriefHooks(filled, loadConfig(), context.repo, 'ciFix');
    },
    delivered(context, plan) {
      const rounds = plan.state && typeof plan.state === 'object' && !Array.isArray(plan.state) ? plan.state.rounds : undefined;
      if (!Array.isArray(rounds)) return;
      const consumed = rounds.filter((value): value is string => typeof value === 'string');
      new WatchJournal().update(context.snapshot.key, (snapshot) => {
        if (!snapshot || snapshot.status === 'retired' || snapshot.generation !== context.snapshot.generation) return { result: undefined };
        const state = snapshot.state as PrWatchState;
        state.checkRounds = [...new Set([...(state.checkRounds ?? []), ...consumed])].slice(-100);
        return { snapshot, result: undefined };
      });
      recordCheckRounds(context.snapshot.key, consumed);
    },
  };
}
