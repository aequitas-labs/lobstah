import { deriveGlassPrs } from '../glass-prs.js';
import { evidencePrs, observedPrs } from '../watch-presenters/pr.js';
import {
  loadConfig,
  orderedDispatchPrUrls,
  parsePrRef,
  prBadge,
  prNewestFirst,
  readPr,
  readPrs,
  prReviewUrl,
  prKeyLabel,
  prLabel,
  prMergeStatus,
} from '@lobstah/core';
import type { PrEvidence } from '@lobstah/core';
import type { TendDispatch, TendStory } from '../tend.js';

function prsOf(chain: TendDispatch[]): string[] | undefined {
  const urls = [...new Set(chain.flatMap((d) => d.prUrls ?? []))].filter((url) => readPr(parsePrRef(url)?.key ?? url)?.state !== 'CLOSED');
  if (urls.length < 2) return undefined;
  const positions = Object.assign({}, ...chain.map((dispatch) => dispatch.prPositions ?? {})) as NonNullable<
    import('@lobstah/core').Evidence['prPositions']
  >;
  const ordered = orderedDispatchPrUrls({ prUrls: urls, prPositions: positions });
  return ordered.map((u) => {
    const ref = parsePrRef(u);
    const record = ref ? readPr(ref.key) : undefined;
    const prefix = positions[u] ? `${positions[u]!.position}/${positions[u]!.size} ` : '';
    return prefix + (record ? `${prBadge(record).text} ${u}` : u);
  });
}

/**
 * The chain's PR state as a badge — the one derivation tend, catch, and glass
 * share. A chain with several PRs shows the one first seen last.
 */
function prStateOf(chain: TendDispatch[]): string | undefined {
  const records = chain
    .map((d) => parsePrRef(d.prUrl ?? d.pr?.url ?? ''))
    .filter((ref) => ref !== undefined)
    .map((ref) => readPr(ref.key))
    .filter((pr): pr is NonNullable<typeof pr> => pr !== undefined && ['OPEN', 'MERGED', 'CLOSED'].includes(pr.state));
  const record = records.sort(prNewestFirst(records))[0];
  if (record) return prBadge(record).text;
  const observed = chain
    .filter((dispatch) => (dispatch.prUrls?.length ?? 0) < 2)
    .map((d) => d.pr)
    .filter((p): p is PrEvidence => p !== undefined)
    .sort((a, b) => b.number - a.number || b.observedAt.localeCompare(a.observedAt))[0];
  return observed ? prBadge(observed).text : undefined;
}

export function cachedPrPresentation(now: number) {
  const records = readPrs(),
    legacy = evidencePrs(),
    observed = observedPrs(records, legacy),
    cfg = loadConfig();
  const stacks = deriveGlassPrs(
    legacy.map(({ id, pr }) => ({ id, pr })),
    [],
    records,
    { readySettleSecs: cfg.readySettleSecs, now },
  ).stacks.filter((stack) => stack.open);
  return { records, legacy, observed, stacks };
}

function orderStories(stories: TendStory[], observed: ReturnType<typeof observedPrs>): TendStory[] {
  // Stories with a PR take the shared PR order (first seen, newest first) in
  // the slots PR stories hold; a story whose PR has no observation goes last.
  const byPrUrl = new Map(observed.map(({ pr }) => [pr.url, pr]));
  const newestFirst = prNewestFirst(observed.map(({ pr }) => pr));
  const prStories = stories
    .filter((s) => s.prUrl)
    .sort((a, b) => {
      const pa = byPrUrl.get(a.prUrl!),
        pb = byPrUrl.get(b.prUrl!);
      return pa && pb ? newestFirst(pa, pb) : Number(!pa) - Number(!pb);
    });
  let prIndex = 0;
  stories.forEach((s, i) => {
    if (s.prUrl) stories[i] = prStories[prIndex++]!;
  });
  return stories;
}

export const prTendQueries = {
  'story.fields': ({ chain }: { chain: TendDispatch[] }) => ({ prs: prsOf(chain), prState: prStateOf(chain) }),
  'stories.order': ({ stories, observed }: { stories: TendStory[]; observed: ReturnType<typeof observedPrs> }) =>
    orderStories(stories, observed),
  'tend.cached': ({ now }: { now: number }) => cachedPrPresentation(now),
  'view.review-link': ({ url, tools }: { url: string; tools: Parameters<typeof prReviewUrl>[1] }) => prReviewUrl(url, tools),
  'view.key-label': ({ key, title }: { key: string; title?: string }) => prKeyLabel(key, title),
  'view.label': ({ record }: { record: Parameters<typeof prLabel>[0] }) => prLabel(record),
  'view.merge-requests': () =>
    readPrs()
      .filter((pr) => pr.mergeRequest)
      .map((pr) => ({
        pr: pr.key,
        by: pr.mergeRequest!.by,
        at: pr.mergeRequest!.at,
        method: pr.mergeRequest!.method,
        status: prMergeStatus(pr),
        hold: pr.mergeRequest!.hold,
        note: pr.mergeRequest!.note,
        sha: pr.mergeRequest!.mergeSha,
      })),
};
