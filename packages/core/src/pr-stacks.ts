import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { parsePrRef, prBadge, prStandingKinds } from './pr.js';
import type { PrEvidence } from './pr.js';
import { uniqueTempPath, atomicRenameSync, lobstahHome } from './paths.js';
import { listNotices, noticesDir, postNotice } from './notices.js';
import { readPrs, withPrLock } from './prs.js';

export interface PrStack {
  /** Born at the bottom PR; persisted membership carries it across merges. */
  id: string;
  repo: string;
  members: PrEvidence[];
  ready: number;
  allReady: boolean;
  text: string;
  /** Read-only views are silent even before the watch migrates old state. */
  legacy?: boolean;
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
    const settleSecs = opts.readySettleSecs ?? 0;
    // A member inside its settle window is not ready for the stack either.
    const isReady = (p: PrEvidence) => prStandingKinds(p, { readySettleSecs: settleSecs, now }).includes('pr:ready');
    const ready = members.filter(isReady).length;
    const allReady = ready === members.length;
    const order = members.map((p) => `#${p.number}`).join(' → ');
    const waiting = members.filter((p) => !isReady(p)).map((p) => `#${p.number} ${waitingReason(p, settleSecs, now)}`).join('; ');
    out.push({ id: parsePrRef(bottom.url)!.key, repo: repo(bottom), members, ready, allReady,
      text: allReady
        ? `stack ready to merge: ${repo(bottom)} ${order} (${members.length} PRs, all green) — merge in this order, bottom first`
        : `stack waiting: ${ready} of ${members.length} ready: ${repo(bottom)} ${order} — ${waiting}` });
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

interface StackEpoch {
  version?: 2;
  heads: Record<string, string>;
  ready: boolean;
  epoch: number;
  at: string;
  notified?: boolean;
  /** Legacy duplicates collapse silently until the next real transition. */
  silent?: boolean;
}
const stateFile = () => path.join(lobstahHome(), 'pr-stacks.json');
export function readStackEpochs(): Record<string, StackEpoch> {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
const headsOf = (s: PrStack) => Object.fromEntries(s.members.map((p) => [parsePrRef(p.url)!.key, p.headSha]));
export const stackStateHash = (s: Pick<PrStack, 'id'>, epoch = 0) => createHash('sha1').update(JSON.stringify([s.id, epoch])).digest('hex').slice(0, 16);

/** Membership, not branches/heads/watch owners, connects successive observations. */
export function identifyPrStacks(stacks: PrStack[], state = readStackEpochs()): PrStack[] {
  const used = new Set<string>();
  return stacks.map((s) => {
    const keys = Object.keys(headsOf(s));
    const matches = Object.entries(state).filter(([id]) => !used.has(id)).map(([id, old]) => ({
      id, old, overlap: keys.filter((key) => key in old.heads).length,
    })).filter((x) => x.overlap > 0).sort((a, b) => b.overlap - a.overlap || a.old.at.localeCompare(b.old.at) || a.id.localeCompare(b.id));
    const id = matches[0]?.old.version === 2 ? matches[0].id : s.id;
    used.add(id);
    return { ...s, id, legacy: matches.some((m) => m.old.version !== 2) };
  });
}

/** Existing watch observations/cadence only; persistent epochs survive daemon restarts. */
export function syncStackReadiness(cfg = loadConfig(), now = Date.now()): void {
  const records = readPrs();
  // Reuse the existing cross-process PR lock for the small aggregate file.
  withPrLock('pr:lobstah/stack-state#0', () => {
    const state = readStackEpochs();
    const stacks = identifyPrStacks(derivePrStacks(records, { trunk: (r) => prStackTrunk(cfg, r), readySettleSecs: cfg.readySettleSecs, now }), state);
    const notices = listNotices(Number.MAX_SAFE_INTEGER).filter((n) => n.kind === 'stack-ready');
    const kept = new Set<string>();
    for (const s of stacks) {
      const heads = headsOf(s);
      const aliases = Object.keys(state).filter((id) => Object.keys(heads).some((key) => key in state[id]!.heads));
      const old = state[s.id] ?? aliases.map((id) => state[id]!).sort((a, b) => b.at.localeCompare(a.at))[0];
      const previous = notices.filter((n) => n.refId === s.id || aliases.includes(n.refId ?? '') || n.refId! in heads);
      const migrating = (!!old && old.version !== 2) || (!old && previous.length > 0);
      const removed = old ? Object.keys(old.heads).filter((key) => !(key in heads)) : [];
      const partialMerge = !!old && Object.entries(heads).every(([key, sha]) => old.heads[key] === sha) &&
        removed.every((key) => records.find((p) => p.key === key)?.state === 'MERGED');
      const changed = !!old && !partialMerge && JSON.stringify(heads) !== JSON.stringify(old.heads);
      // A retarget can restart the settle clock without changing any heads.
      const settlingOnly = !!old?.notified && !changed && s.members.every((p) => prStandingKinds(p).includes('pr:ready'));
      const epoch = (old?.epoch ?? 0) + Number(changed || (!!old?.ready && !s.allReady && !settlingOnly));
      const next: StackEpoch = { version: 2, heads, ready: s.allReady, epoch,
        at: !old || changed || old.ready !== s.allReady ? new Date(now).toISOString() : old.at,
        notified: migrating ? s.allReady : changed || (!s.allReady && !settlingOnly) ? false : old?.notified,
        silent: migrating || (!changed && (s.allReady || settlingOnly) && !!old?.silent) };
      const wake = s.allReady && !next.notified && !migrating;
      const current = previous.at(-1);
      const fields = { kind: 'stack-ready' as const, text: s.text, refId: s.id, url: s.members.at(-1)!.url,
        stateHash: stackStateHash(s, epoch), repo: repoKey(cfg, s.repo),
        quiet: migrating || !s.allReady || !stackReadyEnabled(cfg) || (!wake && (!current || !!current.quiet)) };
      // Update the existing item without moving its delivery cursor. Only a
      // ready transition gets a new seq; supersede, never append history items.
      const notice = wake || !current ? postNotice(fields)! : { ...current, ...fields };
      if (current && !wake) {
        const file = path.join(noticesDir(), `${notice.seq}.json`), tmp = uniqueTempPath(file);
        fs.writeFileSync(tmp, JSON.stringify(notice)); atomicRenameSync(tmp, file);
      }
      kept.add(notice.seq);
      if (s.allReady) next.notified = true;
      for (const alias of aliases) if (alias !== s.id) delete state[alias];
      state[s.id] = next;
    }
    // Old shapes and stacks that no longer exist are not standing notices.
    for (const n of notices) if (!kept.has(n.seq)) fs.rmSync(path.join(noticesDir(), `${n.seq}.json`), { force: true });
    // A temporarily incomplete chain still invalidates its old ready epoch
    // on a changed head or a genuinely unready surviving member.
    for (const [id, old] of Object.entries(state)) {
      if (stacks.some((s) => s.id === id)) continue;
      const surviving = records.filter((p) => p.state === 'OPEN' && p.key in old.heads);
      if (old.ready && (surviving.length === 0 || surviving.length >= 2 || records.some((p) => p.key in old.heads && p.state === 'CLOSED') ||
        surviving.some((p) => p.headSha !== old.heads[p.key] ||
        !prStandingKinds(p, { readySettleSecs: cfg.readySettleSecs, now }).includes('pr:ready')))) {
        old.ready = false; old.notified = false; old.epoch++; old.at = new Date(now).toISOString();
      }
    }
    const file = stateFile(), tmp = uniqueTempPath(file);
    fs.writeFileSync(tmp, JSON.stringify(state)); atomicRenameSync(tmp, file);
  });
}

export function repoKey(cfg: Config, forgeRepo: string): string {
  return Object.entries(cfg.repos).find(([, r]) =>
    r.origin?.replace(/\.git$/, '').endsWith(`/${forgeRepo}`) ||
    r.origin?.replace(/\.git$/, '') === `git@github.com:${forgeRepo}`)?.[0] ?? forgeRepo;
}
