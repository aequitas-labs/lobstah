import { createHash } from 'node:crypto';
import { StackWatchType } from '@lobstah/watch-types/stack';
import { presentLegacyAttention } from '@lobstah/watch-types/legacy-presentation';
import { watchJson } from '@lobstah/watch-types';
import type { StackWatchServices, StackWatchView } from '@lobstah/watch-types/stack';
import type { WatchPresentation, WatchValue } from '@lobstah/watch-types';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { cutPrTitle, parsePrRef, prBadge, prNote, prStandingKinds } from './pr.js';
import type { PrEvidence } from './pr.js';
import { derivePrStacks, repoKey, stackReadyEnabled } from './pr-stacks.js';
import { readPrs } from './prs.js';
import { identifyPrStacks, readStackEpochs, reconcileStackReadiness, stackStateHash } from './stack-watch-state.js';
import { WatchRegistry } from '@lobstah/watch-types';
import { WatchRuntime } from './watch-runtime.js';

/** Host-specific ownership and member detail are source ports during legacy UI migration. */
export interface StackWatchSourceOptions {
  commands?: StackWatchServices['commands'];
  registration?: StackWatchServices['registration'];
  config?: () => Config;
  records?: () => readonly PrEvidence[];
  member?: (pr: PrEvidence) => { kinds: string[]; note: string };
  owner?: (pr: PrEvidence) => { id: string; lane: 'work' | 'chore' };
  automation?: StackWatchServices['automation'];
  effectHandler?: StackWatchServices['effectHandler'];
}

/** Derive from cached PR records only; this is also safe for read-only views. */
export function stackWatchViews(now: number, cfg = loadConfig(), options: StackWatchSourceOptions = {}): StackWatchView[] {
  const epochs = readStackEpochs(),
    records = options.records?.() ?? readPrs();
  const views: StackWatchView[] = identifyPrStacks(derivePrStacks(records, { readySettleSecs: cfg.readySettleSecs, now }), epochs).map(
    (stack) => {
      const epoch = epochs[stack.id],
        top = stack.members.at(-1)!;
      const members = stack.members.map((pr) => {
        const details = options.member?.(pr) ?? {
          kinds: prStandingKinds(pr, { readySettleSecs: cfg.readySettleSecs, now }),
          note: prNote(pr, prBadge(pr).text),
        };
        return {
          key: parsePrRef(pr.url)!.key,
          url: pr.url,
          number: pr.number,
          ...(pr.title ? { title: pr.title } : {}),
          note: details.note,
          kinds: details.kinds,
        };
      });
      const owner = options.owner?.(top) ?? { id: parsePrRef(top.url)!.key, lane: 'work' as const };
      const fields = watchJson({
        ...owner,
        repo: repoKey(cfg, stack.repo),
        prUrl: top.url,
        ...(stack.title
          ? {
              headline: `${cutPrTitle(stack.title, 40)} (${stack.allReady ? `${members.length} PRs, all green` : `${stack.ready} of ${members.length} ready`})`,
            }
          : {}),
        stack: {
          ...(stack.title ? { title: stack.title } : {}),
          ready: stack.ready,
          total: members.length,
          allReady: stack.allReady,
          members,
        },
      }) as Record<string, WatchValue>;
      return {
        rootKey: stack.id,
        repo: stack.repo,
        title: stack.title ?? `Stack through #${top.number}`,
        summary: stack.text,
        ready: stack.ready,
        allReady: stack.allReady,
        active: true,
        epoch: epoch?.epoch ?? 0,
        since: epoch?.at ?? stack.members[0]!.observedAt,
        stateHash: stackStateHash(stack, epoch?.epoch),
        quiet: !stack.allReady || !!epoch?.silent || !!stack.legacy,
        members: stack.members.map((pr) => ({
          key: parsePrRef(pr.url)!.key,
          url: pr.url,
          number: pr.number,
          headSha: pr.headSha,
          ...(pr.title ? { title: pr.title } : {}),
        })),
        fields,
      };
    },
  );
  // An accepted native request still needs reconciliation after the graph shrinks below two open members.
  const requests = readPrs();
  for (const root of requests) {
    if (!root.stackMergeRequest || views.some((view) => view.rootKey === root.key)) continue;
    const members = root.stackMergeRequest.numbers
      .map((number) => requests.find((pr) => pr.repo === root.repo && pr.number === number))
      .filter((pr) => !!pr);
    views.push({
      rootKey: root.key,
      repo: root.repo,
      title: root.title ?? 'Stack merge',
      summary: 'Waiting for the recorded stack merge result.',
      ready: 0,
      allReady: false,
      active: false,
      epoch: epochs[root.key]?.epoch ?? 0,
      since: root.stackMergeRequest.at,
      stateHash: createHash('sha256')
        .update(JSON.stringify([root.stackMergeRequest, members]))
        .digest('hex'),
      quiet: true,
      members: members.map((pr) => ({ key: pr.key, url: pr.url, number: pr.number, headSha: pr.headSha })),
      fields: {},
    });
  }
  return views;
}

/** Stack display and operating instructions are part of the source contract. */
export function presentStackWatch(view: StackWatchView | null): WatchPresentation {
  const title = view?.title ?? 'Stack',
    links = view?.members.length ? [{ label: 'Open stack', url: view.members.at(-1)!.url }] : [];
  const key = view ? `stack:${view.rootKey}` : 'stack:unknown';
  return {
    title,
    summary: view?.summary ?? '',
    label: 'Stack',
    tone: view?.allReady ? 'ok' : 'warning',
    worker: { steps: ['Read the stack members in bottom-first order and their recorded merge authority before changing a branch.'] },
    helm: {
      steps: [
        'Keep one readiness item for this stack. Its link follows the current top PR; a bottom-first merge keeps the stack identity.',
        'Merge only with a recorded request or the configured approval policy. Read the supplied hold before starting another repair.',
      ],
      read: { executable: 'lobstah', args: ['prs'] },
    },
    rows: view
      ? [
          { label: 'Readiness', value: `${view.ready} of ${view.members.length} ready` },
          { label: 'Order', value: view.members.map((member) => `#${member.number}`).join(' → ') },
        ]
      : [],
    links,
    actions: [{ id: 'advance', label: 'Advance authorized stack merge', requiresAuthority: true, automatic: true }],
    attention: view?.active
      ? [
          {
            id: 'readiness',
            key,
            fields: view.fields,
            kind: 'stack-ready',
            stateHash: view.stateHash,
            since: view.since,
            summary: view.summary,
            quiet: view.quiet,
            blocking: false,
            presentation: {
              ...presentLegacyAttention({
                kind: 'stack-ready',
                verb: 'stack-ready',
                key,
                note: view.summary,
                headline: typeof view.fields.headline === 'string' ? view.fields.headline : undefined,
                prUrl: links[0]?.url,
                stack: { allReady: view.allReady, members: view.members },
              }),
              suppresses: view.members.map((member) => ({ key: member.key, kind: 'pr:ready' })),
            },
          },
        ]
      : [],
  };
}
const revision = (view: StackWatchView): string => createHash('sha256').update(JSON.stringify(view)).digest('hex');

/** PR snapshot changes feed this adapter; no stack observer queries GitHub. */
export function createStackWatchType(options: StackWatchSourceOptions = {}): StackWatchType {
  return new StackWatchType({
    commands: options.commands,
    registration: options.registration,
    noticePolicy: { kinds: ['stack-ready'], current(notice) {
      const epoch = notice.refId ? readStackEpochs()[notice.refId] : undefined;
      return !!epoch?.ready && notice.stateHash === stackStateHash({ id: notice.refId! }, epoch.epoch) && stackReadyEnabled(options.config?.() ?? loadConfig());
    } },
    automation: options.automation,
    effectHandler: options.effectHandler,
    derived: {
      views(now) {
        return stackWatchViews(Date.parse(now), options.config?.() ?? loadConfig(), options).map((view) => ({
          key: `stack:${view.rootKey}`,
          input: `stack:${view.rootKey}`,
          options: {},
          owner: { kind: 'helm' as const, grounds: 'home' },
          revision: revision(view),
          since: view.since,
          presentation: presentStackWatch(view),
        }));
      },
    },
    observe({ snapshot, now }) {
      const view = stackWatchViews(Date.parse(now), options.config?.() ?? loadConfig(), options).find(
        (entry) => entry.rootKey === snapshot.reference.rootKey,
      );
      return view
        ? { cursor: revision(view), events: [], payload: watchJson(view) }
        : { cursor: snapshot.cursor, events: [], payload: null, done: true };
    },
    present(snapshot) {
      return presentStackWatch(snapshot.state.view);
    },
    failure(error) {
      return { kind: 'stack', message: error instanceof Error ? error.message : String(error) };
    },
  });
}

/** Keep epoch/notice parity, then checkpoint only changed derived views. */
export function syncDerivedStackWatches(cfg = loadConfig(), now = Date.now()): void {
  reconcileStackReadiness(cfg, now);
  const adapter = createStackWatchType({ config: () => cfg }),
    registry = new WatchRegistry();
  registry.register(adapter);
  const runtime = new WatchRuntime(registry),
    current = adapter.derived.views(new Date(now).toISOString());
  for (const view of current) {
    const prior = runtime.journal.read(view.key);
    if (prior?.status === 'watching' && prior.cursor === view.revision) continue;
    if (!prior || prior.status === 'retired') runtime.register('stack', view.input, view.options, view.owner);
    runtime.checkSync(view.key, { now, everySecs: 0 });
  }
  const live = new Set(current.map((view) => view.key));
  for (const snapshot of runtime.journal.list())
    if (snapshot.type.id === 'stack' && snapshot.status !== 'retired' && !live.has(snapshot.key)) runtime.retire(snapshot.key);
}
