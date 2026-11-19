import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { parsePrRef, prStandingKinds } from './pr.js';
import { uniqueTempPath, atomicRenameSync, lobstahHome } from './paths.js';
import { listNotices, noticesDir, postNotice } from './notices.js';
import { readPrs, withPrLock } from './prs.js';
import { derivePrStacks, repoKey, stackReadyEnabled } from './pr-stacks.js';
import type { PrStack } from './pr-stacks.js';

export interface StackEpoch {
  version?: 2;
  heads: Record<string, string>;
  ready: boolean;
  epoch: number;
  at: string;
  notified?: boolean;
  /** Legacy duplicates collapse silently until the next real transition. */
  silent?: boolean;
  /** Member keys the stack's latest ready notification named. */
  announced?: string[];
  /**
   * Member keys the notification before it named: present once a change to
   * the stack replaced a ready notification, so its text says what changed.
   */
  priorMembers?: string[];
}
const stateFile = () => path.join(lobstahHome(), 'pr-stacks.json');
export function readStackEpochs(): Record<string, StackEpoch> {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}
const headsOf = (s: PrStack) => Object.fromEntries(s.members.map((p) => [parsePrRef(p.url)!.key, p.headSha]));
/**
 * A stack's text with what changed since its previous ready notification:
 * the PRs added, else the stack's range, e.g. "Stack updated · #2560 added".
 * A waiting stack, or one notified only once, keeps its plain text.
 */
export function stackText(s: Pick<PrStack, 'members' | 'allReady' | 'text'>, epoch?: Pick<StackEpoch, 'priorMembers'>): string {
  const change = stackChange(s, epoch);
  return change ? `${change} — ${s.text}` : s.text;
}

/** What changed since the previous ready notification, in words; undefined when there is nothing to say. */
function stackChange(s: Pick<PrStack, 'members' | 'allReady'>, epoch?: Pick<StackEpoch, 'priorMembers'>): string | undefined {
  if (!s.allReady || !epoch?.priorMembers) return undefined;
  const added = s.members.filter((p) => !epoch.priorMembers!.includes(parsePrRef(p.url)!.key)).map((p) => `#${p.number}`);
  return `Stack updated · ${added.length ? `${added.join(', ')} added` : `#${s.members[0]!.number}–#${s.members.at(-1)!.number}`}`;
}
export const stackStateHash = (s: Pick<PrStack, 'id'>, epoch = 0) =>
  createHash('sha1')
    .update(JSON.stringify([s.id, epoch]))
    .digest('hex')
    .slice(0, 16);

/** Membership, not branches/heads/watch owners, connects successive observations. */
export function identifyPrStacks(stacks: PrStack[], state = readStackEpochs()): PrStack[] {
  const used = new Set<string>();
  return stacks.map((s) => {
    const keys = Object.keys(headsOf(s));
    const matches = Object.entries(state)
      .filter(([id]) => !used.has(id))
      .map(([id, old]) => ({
        id,
        old,
        overlap: keys.filter((key) => key in old.heads).length,
      }))
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.old.at.localeCompare(b.old.at) || a.id.localeCompare(b.id));
    const id = matches[0]?.old.version === 2 ? matches[0].id : s.id;
    used.add(id);
    const change = stackChange(s, state[id]);
    return {
      ...s,
      id,
      text: stackText(s, state[id]),
      state: change ? `${change} — ${s.state}` : s.state,
      legacy: matches.some((m) => m.old.version !== 2),
    };
  });
}

/** Existing watch observations/cadence only; persistent epochs survive daemon restarts. */
export function reconcileStackReadiness(cfg = loadConfig(), now = Date.now()): void {
  const records = readPrs();
  // Reuse the existing cross-process PR lock for the small aggregate file.
  withPrLock('pr:lobstah/stack-state#0', () => {
    const state = readStackEpochs();
    const derived = derivePrStacks(records, { readySettleSecs: cfg.readySettleSecs, now });
    // Identified stacks carry the old epoch's text; this pass writes the next one's.
    const stacks = identifyPrStacks(derived, state).map((s, i) => ({ ...s, text: derived[i]!.text }));
    const notices = listNotices(Number.MAX_SAFE_INTEGER).filter((n) => n.kind === 'stack-ready');
    const kept = new Set<string>();
    for (const s of stacks) {
      const heads = headsOf(s);
      const aliases = Object.keys(state).filter((id) => Object.keys(heads).some((key) => key in state[id]!.heads));
      const old = state[s.id] ?? aliases.map((id) => state[id]!).sort((a, b) => b.at.localeCompare(a.at))[0];
      const previous = notices.filter((n) => n.refId === s.id || aliases.includes(n.refId ?? '') || n.refId! in heads);
      const migrating = (!!old && old.version !== 2) || (!old && previous.length > 0);
      const removed = old ? Object.keys(old.heads).filter((key) => !(key in heads)) : [];
      const partialMerge =
        !!old &&
        Object.entries(heads).every(([key, sha]) => old.heads[key] === sha) &&
        removed.every((key) => records.find((p) => p.key === key)?.state === 'MERGED');
      const changed = !!old && !partialMerge && JSON.stringify(heads) !== JSON.stringify(old.heads);
      // A retarget can restart the settle clock without changing any heads.
      const settlingOnly = !!old?.notified && !changed && s.members.every((p) => prStandingKinds(p).includes('pr:ready'));
      const epoch = (old?.epoch ?? 0) + Number(changed || (!!old?.ready && !s.allReady && !settlingOnly));
      const next: StackEpoch = {
        version: 2,
        heads,
        ready: s.allReady,
        epoch,
        at: !old || changed || old.ready !== s.allReady ? new Date(now).toISOString() : old.at,
        notified: migrating ? s.allReady : changed || (!s.allReady && !settlingOnly) ? false : old?.notified,
        silent: migrating || (!changed && (s.allReady || settlingOnly) && !!old?.silent),
      };
      const wake = s.allReady && !next.notified && !migrating;
      // A wake after an earlier notification replaces it: the new text names the change.
      next.priorMembers = wake ? old?.announced : old?.priorMembers;
      if (s.allReady) next.announced = Object.keys(heads);
      else if (old?.announced) next.announced = old.announced;
      const current = previous.at(-1);
      const fields = {
        kind: 'stack-ready' as const,
        text: stackText(s, next),
        refId: s.id,
        url: s.members.at(-1)!.url,
        stateHash: stackStateHash(s, epoch),
        repo: repoKey(cfg, s.repo),
        quiet: migrating || !s.allReady || !stackReadyEnabled(cfg) || (!wake && (!current || !!current.quiet)),
      };
      // Update the existing item without moving its delivery cursor. Only a
      // ready transition gets a new seq; supersede, never append history items.
      const notice = wake || !current ? postNotice(fields)! : { ...current, ...fields };
      if (current && !wake) {
        const file = path.join(noticesDir(), `${notice.seq}.json`),
          tmp = uniqueTempPath(file);
        fs.writeFileSync(tmp, JSON.stringify(notice));
        atomicRenameSync(tmp, file);
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
      if (
        old.ready &&
        (surviving.length === 0 ||
          surviving.length >= 2 ||
          records.some((p) => p.key in old.heads && p.state === 'CLOSED') ||
          surviving.some(
            (p) =>
              p.headSha !== old.heads[p.key] || !prStandingKinds(p, { readySettleSecs: cfg.readySettleSecs, now }).includes('pr:ready'),
          ))
      ) {
        old.ready = false;
        old.notified = false;
        old.epoch++;
        old.at = new Date(now).toISOString();
      }
    }
    const file = stateFile(),
      tmp = uniqueTempPath(file);
    fs.writeFileSync(tmp, JSON.stringify(state));
    atomicRenameSync(tmp, file);
  });
}
