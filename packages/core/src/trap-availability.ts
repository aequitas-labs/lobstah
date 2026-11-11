import { ageLabel } from './activity.js';
import type { Config } from './config.js';
import { listRoster } from './roster.js';
import { hasOpenCatch, listTraps, readSessionClaim, trapLastSeen, type TrapRegistration } from './soak.js';
import { listReservations } from './trap-start.js';
import { pendingIds, queuedDescriptor, storedDescriptor } from './queue.js';
import { readStatusLog } from './status.js';
import { planThrow, type ThrowPlanRow } from './throw-plan.js';
import { sessionHolders } from './session-holder.js';

export interface TrapAvailability {
  state: 'free' | 'busy';
  dispatch?: string;
  verb?: string;
  text: string;
}

/** Terminal reports release availability even before the stale claimed pointer is cleared. */
export function trapAvailability(reg: TrapRegistration, now = Date.now()): TrapAvailability {
  if (reg.configured && reg.claimed && !storedDescriptor(reg.claimed, 'work') && !storedDescriptor(reg.claimed, 'chore')) return { state: 'busy', dispatch: reg.claimed, verb: reg.hostedCatch ? 'working' : 'waiting', text: `busy on ${reg.claimed} (wharf)` };
  if (hasOpenCatch(reg)) {
    const id = reg.claimed!;
    const lane = storedDescriptor(id, 'work') ? 'work' : 'chore';
    const last = readStatusLog(id, lane).at(-1);
    const at = last?.at ?? readSessionClaim(id, lane)?.at;
    const age = at ? ageLabel(Math.max(0, now - Date.parse(at))) : 'age unknown';
    const verb = last?.verb ?? 'working';
    return { state: 'busy', dispatch: id, verb, text: `busy on ${id} (${verb}, ${age})` };
  }
  // A queued sticky assignment reserves the free worker before its next park.
  for (const lane of ['chore', 'work'] as const) {
    for (const id of pendingIds(lane)) {
      const d = queuedDescriptor(id, lane);
      if (d?.for !== `wt:${reg.trapId}` && !(d?.target && d.target.profile === reg.configured?.profile && d.target.grounds === reg.configured.grounds)) continue;
      const age = d.queuedAt ? ageLabel(Math.max(0, now - Date.parse(d.queuedAt))) : 'age unknown';
      return { state: 'busy', dispatch: id, verb: 'queued', text: `busy on ${id} (queued, ${age})` };
    }
  }
  return { state: 'free', text: 'free' };
}

export interface RepoTrapCount {
  repo: string;
  /** Traps in use: signed on (free or busy) or starting. The cap counts these. */
  used: number;
  limit?: number;
  /** The in-use traps' names. */
  names: string[];
  /** Roster traps not in use: stowed, and ghosted (the ghost sweep released them). The cap does not count them. */
  stowed: number;
  ghosted: number;
  /** Ghosted traps whose harness session is still open: held, not in use. The helm can end the session. */
  held: string[];
  text: string;
}

/**
 * A repo's traps against its cap (`[repos.<key>].traps`). The cap counts the
 * traps in use: signed on and listening, free or busy, plus those starting.
 * Stowed and ghosted traps don't count: they hold a roster place and a
 * checkout, not a slot. A ghosted trap whose session is still open is named
 * apart, as held, so the helm can end that session.
 */
export function repoTrapCount(cfg: Config, repo: string): RepoTrapCount {
  const inUse = new Map<string, string>();
  for (const r of [...listTraps(), ...listReservations()]) {
    if (r.repo === repo) inUse.set(r.trapId, r.name ?? `wt:${r.trapId}`);
  }
  let stowed = 0;
  let ghosted = 0;
  const held: string[] = [];
  for (const e of listRoster()) {
    if (e.repo !== repo || inUse.has(e.trapId)) continue;
    if (e.state === 'stowed') stowed++;
    else {
      ghosted++;
      if (e.sessionId && sessionHolders(e.sessionId).length) held.push(e.name);
    }
  }
  const limit = cfg.repos[repo]?.traps;
  const used = inUse.size;
  const idle = stowed + ghosted;
  const text =
    `${used}/${limit ?? 'unlimited'} traps in use` +
    (idle ? ` +${idle} stowed/ghosted` : '') +
    (held.length ? `; ${held.sort().join(', ')} ghosted with ${held.length === 1 ? 'its session' : 'their sessions'} still open (end ${held.length === 1 ? 'it' : 'them'})` : '') +
    (limit !== undefined && used > limit ? ' (over limit; stow a trap to free its place)' : '');
  return { repo, used, limit, names: [...inUse.values()].sort(), stowed, ghosted, held: held.sort(), text };
}

/** Whether one more trap may come into use for a repo: new, or returning from stowed or ghosted. */
export function trapCapReached(cfg: Config, repo: string): boolean {
  const count = repoTrapCount(cfg, repo);
  return count.limit !== undefined && count.used >= count.limit;
}

/** Existing candidates to show before an explicit --new, including unavailable ghosted checkouts. */
export function reusableTraps(cfg: Config, repo: string, now = Date.now()): Array<{ name: string; trap: string; state: string; harness: string; why: string }> {
  const live = listTraps();
  const starting = new Set(listReservations().map((r) => r.trapId));
  return [
    ...live.filter((r) => r.repo === repo && trapAvailability(r, now).state === 'free').map((r) => ({
      name: r.name ?? r.trapId, trap: `wt:${r.trapId}`, state: 'free', harness: r.harness,
      why: now - trapLastSeen(r) <= cfg.soak.ttlSecs * 1000 ? 'live' : 'registered but quiet; wait for the ghost sweep',
    })),
    ...listRoster().filter((r) => r.repo === repo && !live.some((l) => l.trapId === r.trapId) && !starting.has(r.trapId)).map((r) => ({
      name: r.name, trap: `wt:${r.trapId}`, state: r.state === 'ghosted' ? 'ghosted' : 'stowed',
      harness: r.profile?.harness ?? r.harness, why: r.leftReason ?? 'rostered checkout',
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export type TrapSelection =
  | { action: 'reuse'; registration: TrapRegistration; why: string }
  | { action: 'return'; row: ThrowPlanRow; why: string }
  | { action: 'new' | 'wait'; why: string };

/** Reuse a fresh free registration, then a safely returnable roster entry, then capacity for a new trap. */
export function selectRepoTrap(cfg: Config, repo: string, harness?: string, now = Date.now(), failedStarts: ReadonlySet<string> = new Set()): TrapSelection {
  if (!cfg.repos[repo]) throw new Error(`no repo "${repo}" is configured`);
  const live = listTraps().filter((r) => r.repo === repo && (!harness || r.harness === harness) &&
    now - trapLastSeen(r) <= cfg.soak.ttlSecs * 1000 && trapAvailability(r, now).state === 'free')
    .sort((a, b) => Number(!!b.firstParkedAt) - Number(!!a.firstParkedAt) || (a.name ?? a.trapId).localeCompare(b.name ?? b.trapId));
  if (live[0]) return { action: 'reuse', registration: live[0], why: `free live ${repo} trap${harness ? ` (${harness})` : ''}` };
  // A stowed or ghosted trap coming back takes a slot, like a new one: at the cap, the work waits.
  if (trapCapReached(cfg, repo)) return { action: 'wait', why: trapCapacityReason(cfg, repo, harness, now) };
  const rows = planThrow(cfg, { repo }, { now });
  const returning = rows.find((r) => !failedStarts.has(r.trapId) && (r.action === 'resume' || r.action === 'cold') && (!harness || r.harness === harness));
  if (returning) return { action: 'return', row: returning, why: `no suitable free live trap; ${returning.why}` };
  return { action: 'new', why: `no suitable free live or returnable stowed trap for ${repo}${harness ? ` (${harness})` : ''}` };
}

export function trapCapacityReason(cfg: Config, repo: string, harness?: string, now = Date.now()): string {
  const count = repoTrapCount(cfg, repo);
  const live = listTraps().filter((r) => r.repo === repo);
  if (count.used > 0 && live.length === count.used && live.every((r) => trapAvailability(r, now).state === 'busy')) {
    return `all ${count.used} ${repo} traps are busy${harness ? `; waiting for a ${harness} trap` : ''}`;
  }
  return `${repo}: ${count.text}; waiting for a suitable free trap${harness ? ` (${harness})` : ''}; check man roster / man throw --plan --repo ${repo} for traps to stow or starting traps`;
}

/** Preflight explicit new throws, including dry runs: a reason never overrides capacity. */
export function guardNewTraps(cfg: Config, repo: string, count: number, reason?: string): void {
  const capacity = repoTrapCount(cfg, repo);
  if (capacity.limit !== undefined && capacity.used + count > capacity.limit) {
    throw new Error(`${repo}: ${capacity.text}; cannot bring ${count} more into use. Traps in use: ${capacity.names.join(', ') || '(none)'}. Use lobstah dispatch --repo ${repo} --trap-any --brief <file>, which waits for a free one, or stow a trap in use.`);
  }
  const reusable = reusableTraps(cfg, repo);
  if (reusable.length && !reason?.trim()) {
    throw new Error(`existing ${repo} traps: ${reusable.map((r) => `${r.name} (${r.state}, ${r.harness})`).join(', ')}. Reuse with lobstah dispatch --repo ${repo} --trap-any --brief <file> or lobstah man throw <name>; to create anyway, use lobstah man throw --new --repo ${repo} --reason "<why these traps do not fit>".`);
  }
}
