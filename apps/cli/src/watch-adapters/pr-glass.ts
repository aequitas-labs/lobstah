import { dispatchPrUrls, loadConfig, prBadge, readPrs } from '@lobstah/core';
import type { GlassDispatch, Watch } from '@lobstah/core';
import { readMergeView } from '@lobstah/pick';
import { deriveGlassPrs, dispatchPrHead, dispatchPrList } from '../glass-prs.js';
import { githubViewer } from '../pr-ownership.js';
import { prMergeMethod } from '../pr-merge.js';

/** Read-only provider projections use the source command boundary. */
export function prGlassProjection(rows: GlassDispatch[], watches: Watch[], shared: GlassDispatch[] = []) {
  const cfg = loadConfig();
  const prRecords = readPrs();
  const recordsByUrl = new Map(prRecords.map((record) => [record.url, record]));
  const mergeView = readMergeView();
  // PR state per dispatch: the evidence badge (the shared derivation tend and
  // catch use) plus the merge view's gate verdict where pick has one.
  const dispatches: GlassDispatch[] = [
    ...rows.map((x) => {
      const observation =
        recordsByUrl.get(x.evidence?.prUrl ?? x.evidence?.pr?.url ?? '') ??
        ((x.evidence?.prUrls?.length ?? 0) > 1 ? undefined : x.evidence?.pr);
      const pr = observation && ['OPEN', 'MERGED', 'CLOSED'].includes(observation.state) ? observation : undefined;
      const url = x.evidence?.prUrl ?? pr?.url;
      const open = mergeView?.open.find((p) => p.uuid === x.id || (url !== undefined && p.url === url));
      return {
        ...x,
        ...(x.evidence ? { evidence: { ...x.evidence, pr } } : {}),
        prBadge: pr ? { ...prBadge(pr), observedAt: pr.observedAt } : undefined,
        prGate: open?.gate,
      };
    }),
    ...shared,
  ];
  // The glass shows a failing watch's whole error cell (reason, exit code,
  // remedy, streak start) wherever it shows lastError — the same text as tend.
  // PR records first (every observation, man-owned or not); evidence for PRs with none yet.
  const { prs, stacks } = deriveGlassPrs(
    dispatches.map((d) => ({ id: d.id, followUp: d.followUp, repoKey: d.repo, pr: d.evidence?.pr, prGate: d.prGate })),
    watches,
    prRecords,
    { readySettleSecs: cfg.readySettleSecs, now: Date.now() },
    () => githubViewer(),
  );
  // Your open PRs say how Merge when green would merge them, so its second tap can.
  for (const p of prs) if (p.mine && p.state === 'OPEN') p.mergeMethod = prMergeMethod(cfg, p.forgeRepo);
  // A dispatch with several PRs lists each, in stack order, with its state.
  for (const d of dispatches as GlassDispatch[]) {
    const urls = d.evidence?.prUrls;
    if (urls && urls.length > 1)
      d.prList = dispatchPrList(
        urls.filter((url) => recordsByUrl.get(url)?.state !== 'CLOSED'),
        prs,
        d.evidence?.prPositions,
      );
    const ev = d.evidence;
    const head =
      ev &&
      dispatchPrHead(
        dispatchPrUrls(ev),
        (url) => recordsByUrl.get(url) ?? (ev.pr?.url === url ? ev.pr : undefined),
        prs,
        d,
        ev.prPositions,
      );
    if (head) d.prHead = head;
  }
  return { dispatches, prs, stacks, mergeView };
}
