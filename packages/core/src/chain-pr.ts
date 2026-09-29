import { readEvidence } from './evidence.js';
import { parsePrRef } from './pr.js';
import { readPrs } from './prs.js';
import { storedDescriptor } from './queue.js';
import type { Lane } from './types.js';
import { laneOf } from './worktrees.js';

export interface ChainPr {
  url: string;
  headRefName?: string;
}

/** The oldest known PR in a dispatch's origin chain is the chain's PR. */
export function chainPr(id: string, lane: Lane): ChainPr | undefined {
  const ancestry: string[] = [];
  const seen = new Set<string>();
  let at: string | undefined = id;
  while (at && !seen.has(at)) {
    ancestry.push(at);
    seen.add(at);
    at = storedDescriptor(at, laneOf(at) ?? lane)?.followUp;
  }
  const records = readPrs();
  for (const member of ancestry.reverse()) {
    const evidence = readEvidence(member, laneOf(member) ?? lane);
    const url = evidence.prUrl ?? evidence.pr?.url;
    const ref = url && parsePrRef(url);
    if (ref) {
      const record = records.find((pr) => pr.key === ref.key);
      return { url: ref.url, headRefName: record?.headRefName ?? evidence.pr?.headRefName ?? evidence.branch };
    }
    const record = records.find((pr) => pr.dispatches.includes(member));
    if (record) return { url: record.url, headRefName: record.headRefName };
  }
  return undefined;
}
