import { syncDerivedStackWatches } from './stack-watch-source.js';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { cutPrTitle, parsePrRef, prBadge, prStandingKinds } from './pr.js';
import type { PrEvidence } from './pr.js';
import { storedDescriptor } from './queue.js';

export interface PrStack {
  /** Born at the bottom PR; persisted membership carries it across merges. */
  id: string;
  repo: string;
  members: PrEvidence[];
  ready: number;
  allReady: boolean;
  /** What the stack is about: see prStackTitle. Absent when nothing names it. */
  title?: string;
  /** The stack's one line for notices and digests. */
  text: string;
  /** The state alone, for a view that already shows the title and the PRs. */
  state: string;
  /** Read-only views are silent even before the watch migrates old state. */
  legacy?: boolean;
}

export function stackReadyEnabled(cfg: Pick<Config, 'attentionKinds'>): boolean {
  return cfg.attentionKinds.includes('pr:ready') || cfg.attentionKinds.includes('stack-ready');
}

/** A PR observation, with the dispatches behind it when it comes from a PR record. */
type StackMember = Pick<PrEvidence, 'url' | 'title' | 'state'> & { dispatches?: readonly string[] };

/** How long a stack's title runs in a heading or a notice. */
const STACK_TITLE_MAX = 60;

/** A brief's name: its leading `#` heading. A follow-up or a brief with no heading has none. */
function briefName(brief: string): string | undefined {
  const first = brief.split(/\r?\n/).find((line) => line.trim());
  return first ? /^#\s+(.+?)\s*#*\s*$/.exec(first)?.[1] : undefined;
}

/** A work dispatch and the ones it follows up, nearest first. Repairs live in the chore lane and name nothing. */
function followUpChain(id: string): Array<{ id: string; brief: string }> {
  const chain: Array<{ id: string; brief: string }> = [];
  const seen = new Set<string>();
  for (let at: string | undefined = id; at && !seen.has(at); ) {
    seen.add(at);
    const descriptor = storedDescriptor(at, 'work');
    if (!descriptor) break;
    chain.push({ id: at, brief: descriptor.brief });
    at = descriptor.followUp;
  }
  return chain;
}

/**
 * The name a stack has from the dispatch that built it: the nearest brief
 * heading on that dispatch's follow-up chain. A stack came from one dispatch
 * when every member's first dispatch shares a chain, and no other open PR
 * does, since that dispatch's title then describes more than this stack.
 */
function dispatchStackName(members: readonly StackMember[], all: readonly StackMember[]): string | undefined {
  const chains = new Map<string, Array<{ id: string; brief: string }>>();
  const chainOf = (p: StackMember): Array<{ id: string; brief: string }> => {
    const first = p.dispatches?.[0];
    if (!first) return [];
    const known = chains.get(first);
    if (known) return known;
    const chain = followUpChain(first);
    chains.set(first, chain);
    return chain;
  };
  const rootOf = (p: StackMember): string | undefined => chainOf(p).at(-1)?.id;
  const root = rootOf(members[0]!);
  if (!root || members.some((p) => rootOf(p) !== root)) return undefined;
  const urls = new Set(members.map((p) => p.url));
  if (all.some((p) => p.state === 'OPEN' && !urls.has(p.url) && rootOf(p) === root)) return undefined;
  for (const { brief } of chainOf(members[0]!)) {
    const name = briefName(brief);
    if (name) return name;
  }
  return undefined;
}

/**
 * What a stack is about: the name its dispatch's brief gives it, else its
 * bottom PR's title. `members` run bottom to top; `all` is every PR observed.
 * Undefined when neither exists, and the stack is shown by its numbers.
 */
export function prStackTitle(members: readonly StackMember[], all: readonly StackMember[]): string | undefined {
  return cutPrTitle(dispatchStackName(members, all) ?? members[0]?.title, STACK_TITLE_MAX) || undefined;
}

/**
 * No forge calls: an unambiguous same-repo chain, not a branch DAG. A stack's
 * bottom may target any branch (`main`, `v12`, a feature branch). A PR whose
 * head more than one open or merged PR has targeted is a long-lived base
 * (`v12` with its own PR to `main`), never a stack member: each PR on it
 * roots its own chain. A stack member's branch carries only the PR above it.
 */
export function derivePrStacks(
  records: readonly PrEvidence[],
  opts: { readySettleSecs?: number; now?: number } = {},
): PrStack[] {
  const now = opts.now ?? Date.now();
  const valid = records.filter((p) => !p.isCrossRepository && p.headRefName && p.baseRefName && parsePrRef(p.url));
  const repo = (p: PrEvidence) => { const r = parsePrRef(p.url)!; return `${r.owner}/${r.repo}`; };
  const inRepo = (p: PrEvidence, q: PrEvidence) => repo(p).toLowerCase() === repo(q).toLowerCase();
  const openChildren = (p: PrEvidence): PrEvidence[] =>
    valid.filter((q) => q.state === 'OPEN' && inRepo(q, p) && q.baseRefName === p.headRefName);
  // Closed PRs are abandoned attempts; merged ones mean work lands on this head.
  const longLived = (p: PrEvidence): boolean =>
    valid.filter((q) => q.state !== 'CLOSED' && inRepo(q, p) && q.baseRefName === p.headRefName).length > 1;
  // A retargeted base is still a merged ancestor's head: no open PR has it.
  const continuesParent = (p: PrEvidence): boolean =>
    valid.some((q) => q.state === 'OPEN' && inRepo(q, p) && q.headRefName === p.baseRefName && !longLived(q));
  const out: PrStack[] = [];
  for (const bottom of valid.filter((p) => p.state === 'OPEN' && !continuesParent(p))) {
    const members = [bottom];
    for (;;) {
      const top = members.at(-1)!;
      if (longLived(top)) break;
      const children = openChildren(top);
      if (children.length !== 1 || members.some((p) => p.url === children[0]!.url)) break;
      members.push(children[0]!);
    }
    if (members.length < 2) continue;
    const settleSecs = opts.readySettleSecs ?? 0;
    // A member inside its settle window is not ready for the stack either.
    const isReady = (p: PrEvidence) => prStandingKinds(p, { readySettleSecs: settleSecs, now }).includes('pr:ready');
    const ready = members.filter(isReady).length;
    const allReady = ready === members.length;
    const order = members.map((p) => `#${p.number}`).join(' → ');
    const range = `#${bottom.number} → #${members.at(-1)!.number}`;
    const waiting = members.filter((p) => !isReady(p)).map((p) => `#${p.number} ${waitingReason(p, settleSecs, now)}`).join('; ');
    const title = prStackTitle(members, valid);
    const count = `${members.length} PRs`;
    // Notices stay one line: the title, the count and the state. A stack with no title falls back to its numbers.
    const text = allReady
      ? title
        ? `stack ready to merge: ${title} (${range}, ${count}, all green)`
        : `stack ready to merge: ${repo(bottom)} ${order} (${count}, all green) — merge in this order, bottom first`
      : title
        ? `stack waiting: ${title} (${range}, ${ready} of ${members.length} ready) — ${waiting}`
        : `stack waiting: ${ready} of ${members.length} ready: ${repo(bottom)} ${order} — ${waiting}`;
    out.push({ id: parsePrRef(bottom.url)!.key, repo: repo(bottom), members, ready, allReady,
      ...(title ? { title } : {}), text,
      state: allReady ? `${count}, all green` : `${ready} of ${members.length} ready — ${waiting}` });
  }
  return out;
}

/**
 * Why a member keeps its stack waiting, in plain words. A green member inside
 * the pr:ready settle window ("settling" internally) is confirming: it has to
 * stay green for the window before it counts.
 */
function waitingReason(p: PrEvidence, settleSecs: number, now: number): string {
  if (p.discoveryPending) return 'awaiting watch check';
  if (!prStandingKinds(p).includes('pr:ready')) return prBadge(p).text;
  const since = Date.parse(p.standingSince?.['pr:ready'] ?? p.observedAt);
  const left = Math.max(1, Math.ceil((since + settleSecs * 1000 - now) / 60_000));
  return `ready, confirming for ${left} more min`;
}

export function prStackTrunk(cfg: Config, forgeRepo: string): string {
  const matches = Object.values(cfg.repos).filter((r) =>
    r.origin?.replace(/\.git$/, '').replace(/\/$/, '').endsWith(`/${forgeRepo}`) ||
    r.origin?.replace(/\.git$/, '') === `git@github.com:${forgeRepo}`);
  return matches[0]?.trunk ?? 'main';
}

export { readStackEpochs, stackText, stackStateHash, identifyPrStacks } from './stack-watch-state.js';

/** Compatibility callers reconcile through the derived stack adapter. */
export function syncStackReadiness(cfg = loadConfig(), now = Date.now()): void { syncDerivedStackWatches(cfg, now); }

export { repoKey } from './repo-key.js';
