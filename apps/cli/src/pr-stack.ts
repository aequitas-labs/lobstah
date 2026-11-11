import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchPrUrls, mergeEvidence, parsePrRef, readEvidence, recordPrDispatch, derivePrStacks, readPrs } from '@lobstah/core';
import type { DispatchPrPosition, Lane, PrRef } from '@lobstah/core';
import { autoRegisterPrWatch } from './pr-watch.js';

/** One subprocess run; tests swap in a fake `git` and `gh`. */
export type StackRun = (cmd: string, args: string[], cwd: string) => { status: number | null; stdout: string };

const defaultRun: StackRun = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: cmd === 'gh' ? 10_000 : 3_000, windowsHide: true });
  return { status: res.error ? null : res.status, stdout: res.stdout ?? '' };
};

/** gh-stack's local state (`<git dir>/gh-stack`, schema 1): the stacks this checkout tracks. */
interface GhStackFile {
  stacks?: Array<{ branches?: Array<{ branch?: string; pullRequest?: { url?: string } }> }>;
}

/** The PRs of the gh stack that holds one of `keys`, bottom to top. Empty when none does. */
function ghStackPrs(cwd: string, keys: Set<string>, run: StackRun): PrRef[][] {
  for (const which of ['--git-dir', '--git-common-dir']) {
    const res = run('git', ['rev-parse', which], cwd);
    if (res.status !== 0 || !res.stdout.trim()) continue;
    let state: GhStackFile;
    try {
      state = JSON.parse(fs.readFileSync(path.join(path.resolve(cwd, res.stdout.trim()), 'gh-stack'), 'utf8')) as GhStackFile;
    } catch {
      continue;
    }
    const groups: PrRef[][] = [];
    for (const stack of state.stacks ?? []) {
      const refs = (stack.branches ?? []).map((b) => (b.pullRequest?.url ? parsePrRef(b.pullRequest.url) : undefined)).filter((r): r is PrRef => !!r);
      if (refs.some((r) => keys.has(r.key))) groups.push(refs);
    }
    if (groups.length) return groups;
  }
  return [];
}

interface ChainPr {
  ref: PrRef;
  head: string;
  base: string;
}

/** Read the PRs of branches the dispatch pushed, scoped to the reported repository. */
function branchPrs(reported: PrRef[], branches: readonly string[], cwd: string, run: StackRun): ChainPr[] {
  if (branches.length < 2 || reported.length === 0) return [];
  const repo = `${reported[0]!.owner}/${reported[0]!.repo}`;
  const byHead = new Map<string, ChainPr>();
  for (const branch of branches) {
    const res = run('gh', ['pr', 'view', branch, '--repo', repo, '--json', 'url,headRefName,baseRefName'], cwd);
    if (res.status !== 0) continue;
    try {
      const view = JSON.parse(res.stdout) as { url?: string; headRefName?: string; baseRefName?: string };
      const ref = view.url ? parsePrRef(view.url) : undefined;
      if (ref && `${ref.owner}/${ref.repo}`.toLowerCase() === repo.toLowerCase() && view.headRefName === branch && view.baseRefName) byHead.set(branch, { ref, head: branch, base: view.baseRefName });
    } catch {
      // Not JSON: no PR for this branch.
    }
  }
  return [...byHead.values()];
}

/** Infer only linear chains. A branch with several children is not a stack. */
function branchStacks(prs: readonly ChainPr[]): PrRef[][] {
  const parent = new Map(prs.map((pr) => [pr.head, pr]));
  const children = (pr: ChainPr): ChainPr[] => prs.filter((child) => child.base === pr.head);
  return prs.filter((pr) => !parent.has(pr.base) || children(parent.get(pr.base)!).length > 1).flatMap((root) => {
    const members = [root];
    for (;;) {
      const next = children(members.at(-1)!);
      if (next.length !== 1 || members.includes(next[0]!)) break;
      members.push(next[0]!);
    }
    return members.length > 1 ? [members.map((member) => member.ref)] : [];
  });
}

/** Discover explicitly reported PRs, tracked gh stacks and every pushed branch with a PR. */
export function dispatchPrDiscovery(reported: readonly string[], opts: { cwd: string; branches?: readonly string[]; run?: StackRun }): {
  urls: string[];
  positions: Record<string, DispatchPrPosition>;
} {
  const run = opts.run ?? defaultRun;
  const refs = reported.map((url) => parsePrRef(url)).filter((ref): ref is PrRef => !!ref);
  const urls = new Map(refs.map((ref) => [ref.key, ref.url]));
  const positions: Record<string, DispatchPrPosition> = {};
  const add = (ref: PrRef): void => { urls.set(ref.key, ref.url); };
  const record = (members: PrRef[]): void => {
    if (members.length < 2) return;
    members.forEach((member, index) => {
      add(member);
      positions[member.url] ??= { bottom: members[0]!.url, position: index + 1, size: members.length };
    });
  };
  if (refs.length) {
    const observed = readPrs();
    const authors = new Set(observed.filter((pr) => urls.has(pr.key)).map((pr) => pr.author).filter(Boolean));
    for (const stack of derivePrStacks(observed)) {
      if (stack.members.some((member) => urls.has(parsePrRef(member.url)!.key)) &&
          stack.members.every((member) => !!member.author && authors.has(member.author))) {
        record(stack.members.map((member) => parsePrRef(member.url)!));
      }
    }
    try { ghStackPrs(opts.cwd, new Set(urls.keys()), run).forEach(record); } catch { /* Reported URLs still count. */ }
    try {
      const pushed = branchPrs(refs, opts.branches ?? [], opts.cwd, run);
      branchStacks(pushed).forEach(record);
      pushed.forEach(({ ref }) => add(ref));
    } catch { /* Keep URLs already known when the forge is unavailable. */ }
  }
  return { urls: [...urls.values()], positions };
}

/** Save all of a dispatch's PRs without losing its previous members or stack positions. */
export function recordDispatchPrs(id: string, lane: Lane, discovery: ReturnType<typeof dispatchPrDiscovery>, watch: boolean): string[] {
  const evidence = readEvidence(id, lane);
  const urls = dispatchPrUrls({ prUrl: evidence.prUrl, prUrls: [...discovery.urls, ...dispatchPrUrls(evidence)] });
  if (!urls.length) return [];
  const positions = { ...evidence.prPositions };
  for (const [url, position] of Object.entries(discovery.positions)) {
    const old = positions[url];
    if (!old || (old.bottom === position.bottom && position.size >= old.size)) positions[url] = position;
  }
  if (JSON.stringify(urls) !== JSON.stringify(dispatchPrUrls(evidence)) ||
      JSON.stringify(positions) !== JSON.stringify(evidence.prPositions ?? {}) || !evidence.prUrl) {
    mergeEvidence(id, lane, { prUrl: urls[0], ...(urls.length > 1 ? { prUrls: urls } : {}), ...(Object.keys(positions).length ? { prPositions: positions } : {}) });
  }
  for (const url of urls) {
    try { recordPrDispatch(parsePrRef(url)!.key, id); } catch { /* A busy observation must not refuse the report. */ }
  }
  return watch ? urls.flatMap((url) => autoRegisterPrWatch(id, url)?.key ?? []) : [];
}

/** The canonical URLs discovered for a report, in report order. */
export function stackPrUrls(reported: readonly string[], opts: { cwd: string; branches?: readonly string[]; run?: StackRun }): string[] {
  return dispatchPrDiscovery(reported, opts).urls;
}
