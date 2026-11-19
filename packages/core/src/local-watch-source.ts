import { createHash } from 'node:crypto';
import { LocalSignalWatchType } from '@lobstah/watch-types/local';
import { presentLegacyAttention } from '@lobstah/watch-types/legacy-presentation';
import { QUIET_LOCAL_NOTICE_KINDS } from '@lobstah/watch-types/local-notices';
import type { LocalSignalSpecification, LocalSignalState } from '@lobstah/watch-types/local';
import type { WatchNotice } from '@lobstah/watch-types';
import type { TendAttention } from './glass.js';
import { activeIds, pendingIds, storedDescriptor } from './queue.js';
import { answeredAt } from './inbox.js';
import { questionEntry, readStatusLog } from './status.js';
import { questionHeld, statusStateHash } from './question-hold.js';
import { decisionViewedAt, questionViewedAt, standingDecisions } from './decisions.js';
import { listReports } from './reports.js';
import { listNotices } from './notices.js';
import { dispatchProgress } from './dispatch-progress.js';
import { reviewAttention } from './reviews.js';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import type { Lane } from './types.js';
import { WatchRuntime } from './watch-runtime.js';
import type { WatchRegistry } from '@lobstah/watch-types';

/** CLI or hosted views can supply already scoped source records without changing the runtime. */
export interface LocalWatchSources {
  suppressions?: (now: number) => NonNullable<LocalSignalState['suppresses']>;
  config?: () => Config;
  status?: (now: number) => TendAttention[];
  decisions?: (now: number) => TendAttention[];
  reports?: (now: number) => TendAttention[];
  landed?: (now: number) => TendAttention[];
  progress?: (now: number) => TendAttention[];
  reviews?: (now: number) => TendAttention[];
}

/** Standing questions use their status revision, independently of wake consumption. */
export function localQuestionAttention(now: number): TendAttention[] {
  const items: TendAttention[] = [];
  for (const lane of ['work', 'chore'] as Lane[])
    for (const id of [...pendingIds(lane), ...activeIds(lane)]) {
      const entry = questionEntry(readStatusLog(id, lane));
      if (!entry || answeredAt(id, lane, entry.at) !== undefined) continue;
      const key = `${lane}:${id}`,
        stateHash = statusStateHash(entry.verb, entry.at),
        repo = storedDescriptor(id, lane)?.repo;
      const viewedAt = questionViewedAt(key, entry.at);
      items.push({
        kind: 'question',
        key,
        stateHash,
        id,
        lane,
        verb: entry.verb,
        ageSecs: Math.max(0, Math.round((now - Date.parse(entry.at)) / 1000)),
        at: entry.at,
        standingSince: entry.at,
        note: entry.note,
        ...(viewedAt ? { viewedAt } : {}),
        ...(repo ? { repo } : {}),
        ...(questionHeld({ key, stateHash, repo }, now) ? { held: true } : {}),
      });
    }
  return items;
}

/** Normalize the existing wire fields without changing public keys or acknowledgment hashes. */
export function localSignalState(items: readonly TendAttention[], rows: LocalSignalState['rows'] = []): LocalSignalState {
  return {
    rows,
    conditions: items.map((item) => {
      const display = item.presentation ?? presentLegacyAttention(item);
      const { ageSecs: _age, ...fields } = item;
      return {
        id: `${item.kind}:${item.key}`,
        key: item.key,
        kind: item.kind,
        stateHash: item.stateHash,
        ...((item.standingSince ?? item.at) ? { since: item.standingSince ?? item.at } : {}),
        summary: item.note ?? '',
        quiet: item.quiet === true,
        blocking: display.blocking,
        presentation: display,
        fields: JSON.parse(JSON.stringify(fields)),
      };
    }),
  };
}

const definitions: Array<LocalSignalSpecification & { read: keyof Omit<LocalWatchSources, 'config' | 'suppressions'> }> = [
  {
    id: 'local-status',
    label: 'Dispatch questions',
    read: 'status',
    kinds: [{ kind: 'question', label: 'Question', defaultEnabled: true }],
    worker: ['Keep the question with its owning dispatch and report again after acting on the answer.'],
    helm: ['Read the standing question and its supplied context. A consumed wake does not answer it.'],
  },
  {
    id: 'local-decisions',
    label: 'Decisions',
    read: 'decisions',
    kinds: [{ kind: 'decision', label: 'Decision', defaultEnabled: true }],
    worker: ['Read the recorded decision answer before continuing its dispatch.'],
    helm: ['Keep the source’s decision key and state hash when presenting or acknowledging a card.'],
  },
  {
    id: 'local-reports',
    label: 'Reports',
    read: 'reports',
    kinds: [{ kind: 'report', label: 'Report', defaultEnabled: false }],
    worker: ['Read the filed report and its attachments before acting on feedback.'],
    helm: ['A report remains visible after its wake is consumed; acknowledgment follows its state hash.'],
  },
  {
    id: 'local-landed',
    label: 'Finished work',
    read: 'landed',
    kinds: [{ kind: 'landed', label: 'Landed', defaultEnabled: false }],
    worker: ['Read the completed catch and its retained artifacts.'],
    helm: ['Report finished catches against their grounds cursor. Do not infer a new task from a terminal status.'],
  },
  {
    id: 'local-progress',
    label: 'Dispatch progress',
    read: 'progress',
    kinds: [{ kind: 'dispatch-progress', label: 'Dispatch progress', defaultEnabled: false }],
    worker: ['Use the dispatch’s current state and ownership before resuming it.'],
    helm: ['Read the supplied progress reason before starting or recovering another worker.'],
  },
  {
    id: 'local-reviews',
    label: 'Review requests',
    read: 'reviews',
    kinds: [],
    worker: ['Read the existing review round and checked head before drafting.'],
    helm: ['Use the configured review-request policy and existing round; do not create a second review for the same head.'],
  },
];

/** Each local reader is an installed adapter, including its role instructions and card metadata. */
export function localWatchTypes(options: LocalWatchSources = {}): LocalSignalWatchType[] {
  const config = options.config ?? loadConfig;
  const defaults: Required<Omit<LocalWatchSources, 'config' | 'suppressions'>> = {
    status: localQuestionAttention,
    decisions: (now) =>
      standingDecisions(now).map((decision) => ({
        kind: 'decision',
        key: decision.key,
        stateHash: decision.stateHash,
        id: decision.dispatch ?? decision.key,
        lane: decision.lane ?? 'work',
        verb: 'decision',
        ageSecs: 0,
        at: decision.askedAt,
        standingSince: decision.askedAt,
        note: decision.title,
        ...(decision.repo ? { repo: decision.repo } : {}),
        ...(decisionViewedAt(decision.key) ? { viewedAt: decisionViewedAt(decision.key) } : {}),
      })),
    reports: () =>
      listReports().map((report) => ({
        kind: 'report',
        key: report.key,
        stateHash: report.stateHash,
        id: report.dispatch ?? report.key.split(':').at(-1)!,
        lane: report.lane ?? 'work',
        verb: 'report',
        ageSecs: 0,
        at: report.filedAt,
        standingSince: report.filedAt,
        note: report.title,
        ...(report.repo ? { repo: report.repo } : {}),
      })),
    landed: () => [],
    progress: (now) =>
      dispatchProgress(now, config()).map((progress) => ({
        kind: 'dispatch-progress',
        key: `progress:${progress.lane}:${progress.id}`,
        stateHash: progress.stateHash,
        id: progress.id,
        lane: progress.lane,
        verb: progress.state,
        ageSecs: progress.ageSecs,
        at: progress.since,
        standingSince: progress.since,
        note: progress.text,
        repo: progress.repo,
        ...(config().attentionKinds.includes('dispatch-progress') ? {} : { quiet: true }),
      })),
    reviews: (now) => (config().reviews.enabled ? reviewAttention(now) : []),
  };
  const sourceState = (definition: (typeof definitions)[number], now: string): LocalSignalState => {
    const items = (options[definition.read] ?? defaults[definition.read])(Date.parse(now)).map((item) => ({
      ...item,
      ...(definition.read === 'reviews' ? { presentation: { ...(item.presentation ?? presentLegacyAttention(item)), always: true } } : {}),
      ...(definition.read === 'decisions' || definition.read === 'reports' ? { petOpen: config().pet.open } : {}),
    }));
    return {
      ...localSignalState(items),
      ...(definition.read === 'decisions' && options.suppressions ? { suppresses: options.suppressions(Date.parse(now)) } : {}),
    };
  };
  const revision = (state: LocalSignalState): string => createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const adapters = definitions.map(
    (definition) =>
      new LocalSignalWatchType(definition, {
        ...(definition.read === 'progress'
          ? {
              noticePolicy: {
                kinds: ['dispatch-progress', 'trap-idle-working'],
                current(notice: WatchNotice) {
                  return dispatchProgress().some((item) => item.id === notice.refId && item.stateHash === notice.stateHash);
                },
              },
            }
          : {}),
        revision,
        read: (now) => sourceState(definition, now),
      }),
  );
  adapters.push(
    new LocalSignalWatchType(
      {
        id: 'local-notices',
        label: 'Notices',
        kinds: [],
        worker: ['Read the notice and its source instructions before acting.'],
        helm: ['Quiet notices remain listed. Their source-owned wake cursor advances without waking the helm.'],
      },
      {
        noticePolicy: { kinds: [], quietKinds: QUIET_LOCAL_NOTICE_KINDS, current: () => true },
        revision,
        read: () => ({ conditions: [], rows: listNotices(5).map((notice) => ({ label: notice.kind, value: notice.text })) }),
      },
    ),
  );
  return adapters;
}

/** Register local adapters once and checkpoint their changed views without replaying their historical wake logs. */
export function syncLocalWatchSources(registry: WatchRegistry, now = Date.now()): void {
  const runtime = new WatchRuntime(registry);
  for (const adapter of registry.list()) {
    if (!adapter.bindings.some((binding) => binding.event === 'local' && binding.field === 'records') || !adapter.derived) continue;
    for (const view of adapter.derived.views(new Date(now).toISOString())) {
      const prior = runtime.journal.read(view.key);
      if (!prior || prior.status === 'retired') runtime.register(adapter.descriptor.id, view.input, view.options, view.owner);
      if (runtime.journal.read(view.key)?.cursor !== view.revision) runtime.checkSync(view.key, { now, everySecs: 0 });
    }
  }
}
