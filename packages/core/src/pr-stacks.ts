import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { parsePrRef, prBadge, prStandingKinds } from './pr.js';
import type { PrEvidence } from './pr.js';
import { lobstahHome } from './paths.js';
import { postNotice } from './notices.js';
import { readPrs, withPrLock } from './prs.js';

export interface PrStack {
  /** The top PR keeps the identity across bottom-first merges. */
  id: string;
  repo: string;
  members: PrEvidence[];
  ready: number;
  allReady: boolean;
  text: string;
}

export function stackReadyEnabled(cfg: Pick<Config, 'attentionKinds'>): boolean {
  return cfg.attentionKinds.includes('pr:ready') || cfg.attentionKinds.includes('stack-ready');
}

/** No forge calls: an unambiguous same-repo chain rooted on trunk, not a branch DAG. */
export function derivePrStacks(
  records: readonly PrEvidence[],
  opts: { trunk?: (repo: string) => string; readySettleSecs?: number; now?: number } = {},
): PrStack[] {
  const now = opts.now ?? Date.now();
  const valid = records.filter((p) => !p.isCrossRepository && p.headRefName && p.baseRefName && parsePrRef(p.url));
  const repo = (p: PrEvidence) => { const r = parsePrRef(p.url)!; return `${r.owner}/${r.repo}`; };
  const inRepo = (p: PrEvidence, q: PrEvidence) => repo(p).toLowerCase() === repo(q).toLowerCase();
  const out: PrStack[] = [];
  for (const bottom of valid.filter((p) => p.state === 'OPEN')) {
    const trunk = opts.trunk?.(repo(bottom)) ?? 'main';
    // During GitHub retargeting, a merged ancestor may still be the base.
    let floor = bottom;
    const seen = new Set([floor.url]);
    while (floor.baseRefName !== trunk) {
      const parents = valid.filter((p) => inRepo(p, floor) && p.headRefName === floor.baseRefName);
      if (parents.length !== 1 || parents[0]!.state !== 'MERGED' || seen.has(parents[0]!.url)) break;
      floor = parents[0]!;
      seen.add(floor.url);
    }
    if (floor.baseRefName !== trunk) continue;
    const members = [bottom];
    for (;;) {
      const top = members.at(-1)!;
      const children = valid.filter((p) => p.state === 'OPEN' && inRepo(p, top) && p.baseRefName === top.headRefName);
      if (children.length !== 1 || members.some((p) => p.url === children[0]!.url)) break;
      members.push(children[0]!);
    }
    if (members.length < 2) continue;
    const isReady = (p: PrEvidence) => prStandingKinds(p, { readySettleSecs: opts.readySettleSecs ?? 0, now }).includes('pr:ready');
    const ready = members.filter(isReady).length;
    const allReady = ready === members.length;
    const order = members.map((p) => `#${p.number}`).join(' → ');
    const waiting = members.filter((p) => !isReady(p)).map((p) =>
      `#${p.number} (${p.discoveryPending ? 'awaiting watch check' : prStandingKinds(p).includes('pr:ready') ? 'settling' : prBadge(p).text})`).join(', ');
    out.push({ id: parsePrRef(members.at(-1)!.url)!.key, repo: repo(bottom), members, ready, allReady,
      text: allReady
        ? `stack ready to merge: ${repo(bottom)} ${order} (${members.length} PRs, all green) — merge in this order, bottom first`
        : `stack ${ready}/${members.length} ready: ${repo(bottom)} ${order}, waiting: ${waiting}` });
  }
  return out;
}

export function prStackTrunk(cfg: Config, forgeRepo: string): string {
  const matches = Object.values(cfg.repos).filter((r) =>
    r.origin?.replace(/\.git$/, '').replace(/\/$/, '').endsWith(`/${forgeRepo}`) ||
    r.origin?.replace(/\.git$/, '') === `git@github.com:${forgeRepo}`);
  return matches[0]?.trunk ?? 'main';
}

interface StackEpoch {
  heads: Record<string, string>;
  ready: boolean;
  epoch: number;
  at: string;
  notified?: boolean;
}
const stateFile = () => path.join(lobstahHome(), 'pr-stacks.json');
export function readStackEpochs(): Record<string, StackEpoch> {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
const headsOf = (s: PrStack) => Object.fromEntries(s.members.map((p) => [parsePrRef(p.url)!.key, p.headSha]));
export const stackStateHash = (s: Pick<PrStack, 'id'>, epoch = 0) => createHash('sha1').update(JSON.stringify([s.id, epoch])).digest('hex').slice(0, 16);

/** The last unchanged head of an already-announced stack is not a new lone-PR invitation. */
export function quietStackTailUrls(records: readonly PrEvidence[], epochs = readStackEpochs()): string[] {
  const byKey = new Map(records.map((p) => [parsePrRef(p.url)?.key, p]));
  return Object.values(epochs).flatMap((s) => {
    if (!s.ready || !s.notified) return [];
    const members = Object.entries(s.heads).map(([key, sha]) => ({ p: byKey.get(key), sha }));
    const open = members.filter(({ p }) => p?.state === 'OPEN');
    return open.length === 1 && open[0]!.p!.headSha === open[0]!.sha &&
      members.every(({ p }) => p?.state === 'OPEN' || p?.state === 'MERGED')
      ? [open[0]!.p!.url] : [];
  });
}

/** Existing watch observations/cadence only; persistent epochs survive daemon restarts. */
export function syncStackReadiness(cfg = loadConfig(), now = Date.now()): void {
  const records = readPrs();
  const stacks = derivePrStacks(records, { trunk: (r) => prStackTrunk(cfg, r), readySettleSecs: cfg.readySettleSecs, now });
  // Reuse the existing cross-process PR lock for the small aggregate file.
  withPrLock('pr:lobstah/stack-state#0', () => {
    const state = readStackEpochs();
    for (const s of stacks) {
      const old = state[s.id];
      const heads = headsOf(s);
      const removed = old ? Object.keys(old.heads).filter((key) => !(key in heads)) : [];
      const partialMerge = !!old && Object.entries(heads).every(([key, sha]) => old.heads[key] === sha) &&
        removed.every((key) => records.find((p) => p.key === key)?.state === 'MERGED');
      const changed = !!old && !partialMerge && JSON.stringify(heads) !== JSON.stringify(old.heads);
      const epoch = (old?.epoch ?? 0) + Number(changed || (!!old?.ready && !s.allReady));
      const next: StackEpoch = { heads, ready: s.allReady, epoch,
        at: !old || changed || old.ready !== s.allReady ? new Date(now).toISOString() : old.at,
        notified: changed || !s.allReady ? false : old?.notified };
      if (s.allReady && !next.notified) {
        postNotice({ kind: 'stack-ready', text: s.text, refId: s.id,
          stateHash: stackStateHash(s, epoch),
          repo: repoKey(cfg, s.repo), quiet: !stackReadyEnabled(cfg),
          dedupeKey: `stack-ready-${s.id}-${epoch}` });
        next.notified = true;
      }
      state[s.id] = next;
    }
    // A temporarily incomplete chain still invalidates its old ready epoch
    // on a changed head or a genuinely unready surviving member.
    for (const [id, old] of Object.entries(state)) {
      if (stacks.some((s) => s.id === id)) continue;
      const surviving = records.filter((p) => p.state === 'OPEN' && p.key in old.heads);
      if (old.ready && (surviving.length === 0 || records.some((p) => p.key in old.heads && p.state === 'CLOSED') ||
        surviving.some((p) => p.headSha !== old.heads[p.key] ||
        !prStandingKinds(p, { readySettleSecs: cfg.readySettleSecs, now }).includes('pr:ready')))) {
        old.ready = false; old.notified = false; old.epoch++; old.at = new Date(now).toISOString();
      }
    }
    const file = stateFile(), tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, file);
  });
}

export function repoKey(cfg: Config, forgeRepo: string): string {
  return Object.entries(cfg.repos).find(([, r]) =>
    r.origin?.replace(/\.git$/, '').endsWith(`/${forgeRepo}`) ||
    r.origin?.replace(/\.git$/, '') === `git@github.com:${forgeRepo}`)?.[0] ?? forgeRepo;
}
