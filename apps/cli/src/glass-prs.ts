import { parsePrRef, prBadge, prSortAt } from '@lobstah/core';
import type { GlassPr, GlassPrWatch, GlassStack, PrEvidence, PrRecord } from '@lobstah/core';

/**
 * The PR picture is derived only from observations already on disk. Read
 * order: PR records (core prs.ts — every observation, man-owned or
 * dispatch-owned) first; a dispatch's evidence `pr` only for a PR that has
 * no record yet (observed before records existed).
 */
export interface GlassPrDispatch {
  id: string;
  followUp?: string;
  repoKey?: string;
  pr?: PrEvidence;
  prGate?: string;
}

export type { GlassPr, GlassPrWatch, GlassStack } from '@lobstah/core';

export function deriveGlassPrs(
  dispatches: readonly GlassPrDispatch[],
  watches: readonly GlassPrWatch[] = [],
  records: readonly PrRecord[] = [],
): { prs: GlassPr[]; stacks: GlassStack[] } {
  const byId = new Map(dispatches.map((d) => [d.id, d]));
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let at = id;
    while (byId.get(at)?.followUp && !seen.has(at)) {
      seen.add(at);
      at = byId.get(at)!.followUp!;
    }
    return at;
  };
  const depthOf = (id: string): number => {
    let at = id, depth = 0;
    const seen = new Set<string>();
    while (byId.get(at)?.followUp && !seen.has(at)) {
      seen.add(at);
      at = byId.get(at)!.followUp!;
      depth++;
    }
    return depth;
  };
  const watchByKey = new Map(watches.map((w) => [w.key, w]));
  // Dispatches per PR url: those whose evidence names it, plus those a record lists.
  const grouped = new Map<string, GlassPrDispatch[]>();
  const add = (url: string, d: GlassPrDispatch) => {
    const group = grouped.get(url) ?? [];
    if (!group.includes(d)) group.push(d);
    grouped.set(url, group);
  };
  for (const d of dispatches) if (d.pr) add(d.pr.url, d);
  const recordByUrl = new Map(records.map((r) => [r.url, r]));
  for (const r of records) {
    for (const id of r.dispatches) {
      const d = byId.get(id);
      if (d) add(r.url, d);
    }
    if (!grouped.has(r.url)) grouped.set(r.url, []);
  }
  const rows: GlassPr[] = [];
  for (const [url, sources] of grouped) {
    const record = recordByUrl.get(url);
    const latest = [...sources].filter((d) => d.pr).sort((a, b) => prSortAt(b.pr!).localeCompare(prSortAt(a.pr!)))[0];
    // Records first; evidence only for a PR with no record yet.
    const pr: PrEvidence | undefined = record ?? latest?.pr;
    const ref = parsePrRef(url);
    if (!ref || !pr) continue;
    const roots = new Set(sources.map((d) => rootOf(d.id)));
    const chained = dispatches.filter((d) => roots.has(rootOf(d.id))).map((d) => d.id);
    // A record also names dispatches since culled from disk: they stay in the chain column.
    const ids = [...new Set([...chained, ...(record?.dispatches ?? [])])]
      .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
    const repoKey = latest?.repoKey ?? sources.find((d) => d.repoKey)?.repoKey;
    rows.push({
      key: ref.key, url, number: pr.number, repo: repoKey ?? `${ref.owner}/${ref.repo}`,
      forgeRepo: `${ref.owner}/${ref.repo}`,
      ...(pr.title ? { title: pr.title } : {}),
      state: pr.state, draft: pr.draft, checks: pr.checks, review: pr.review,
      reviewDecision: pr.reviewDecision, mergeStateStatus: pr.mergeStateStatus,
      baseRefName: pr.baseRefName, headRefName: pr.headRefName, observedAt: pr.observedAt,
      updatedAt: pr.updatedAt, mergedAt: pr.mergedAt, closedAt: pr.closedAt,
      badge: prBadge(pr),
      stackId: ref.key, floor: pr.baseRefName ?? '?', position: 0, nextMergeable: false,
      dispatchIds: ids,
      gate: latest?.prGate ?? sources.find((d) => d.prGate)?.prGate,
      watch: watchByKey.get(ref.key),
    });
  }

  // A parent must be in the same forge repo. Duplicate head branch names are
  // resolved by the newest observation; malformed cycles become independent floors.
  const byHead = new Map<string, GlassPr>();
  for (const row of [...rows].sort((a, b) => prSortAt(a).localeCompare(prSortAt(b)))) {
    if (row.headRefName) byHead.set(`${row.forgeRepo}:${row.headRefName}`, row);
  }
  const parent = new Map<string, GlassPr>();
  for (const row of rows) {
    const candidate = byHead.get(`${row.forgeRepo}:${row.baseRefName ?? ''}`);
    if (candidate && candidate.key !== row.key) parent.set(row.key, candidate);
  }
  const rootOfPr = (row: GlassPr): GlassPr => {
    let at = row;
    const seen = new Set([at.key]);
    while (parent.has(at.key)) {
      const next = parent.get(at.key)!;
      if (seen.has(next.key)) return [...rows].filter((p) => seen.has(p.key)).sort((a, b) => a.key.localeCompare(b.key))[0]!;
      at = next;
      seen.add(at.key);
    }
    return at;
  };
  const groupedStacks = new Map<string, GlassPr[]>();
  for (const row of rows) {
    const root = rootOfPr(row);
    const group = groupedStacks.get(root.key) ?? [];
    group.push(row);
    groupedStacks.set(root.key, group);
  }
  const stacks: GlassStack[] = [];
  for (const [id, members] of groupedStacks) {
    const root = members.find((p) => p.key === id)!;
    const ordered: GlassPr[] = [];
    const visit = (p: GlassPr) => {
      if (ordered.includes(p)) return;
      ordered.push(p);
      members.filter((x) => parent.get(x.key)?.key === p.key).sort((a, b) => a.number - b.number).forEach(visit);
    };
    visit(root);
    // A cyclic or ambiguous relation must never drop a PR from the list.
    for (const p of members) if (!ordered.includes(p)) ordered.push(p);
    const eligible = ordered.find((p) => p.state === 'OPEN' &&
      (p.baseRefName === 'main' || parent.get(p.key)?.state === 'MERGED'));
    ordered.forEach((p, i) => {
      p.stackId = id;
      p.floor = root.baseRefName ?? '?';
      p.position = i;
      p.nextMergeable = p === eligible;
      if (p.state === 'OPEN' && p !== eligible && parent.get(p.key)?.state === 'OPEN') {
        p.blockedBy = parent.get(p.key)!.number;
      }
    });
    const open = ordered.filter((p) => p.state === 'OPEN');
    stacks.push({ id, floor: root.baseRefName ?? '?', repo: root.repo,
      numbers: ordered.map((p) => p.number), open: open.length > 0,
      nextNumber: eligible?.number, behind: eligible ? open.filter((p) => p.position > eligible.position).length : 0 });
  }
  const newest = (s: GlassStack) => groupedStacks.get(s.id)!.reduce((at, p) => at > prSortAt(p) ? at : prSortAt(p), '');
  stacks.sort((a, b) => Number(b.open) - Number(a.open) || newest(b).localeCompare(newest(a)) || a.id.localeCompare(b.id));
  return { prs: stacks.flatMap((s) => groupedStacks.get(s.id)!.sort((a, b) => a.position - b.position)), stacks };
}
