import { displayGrounds, liveHelms, markThreadRelay, postThread, relayedThread, reopenThread, startThread, storageGrounds, ThreadError, listThreads } from '@lobstah/core';
import type { Config, HelmThread } from '@lobstah/core';

/**
 * Slack messages for this boat's own helm. A wharf this boat mirrors to
 * relays each one as a `helm-request` call: the first message of a Slack
 * thread opens a helm thread on its grounds, and what the person adds in
 * that Slack thread joins it. The helm answers with the thread verbs, and
 * the conversation stays in the glass: the daemon's mirror tells the wharf
 * only that the thread changed, and which dispatches it started, so Slack
 * gets a link. It also tells the wharf when a helm signs on for one that waited.
 */

/** The grounds this machine helms itself, as the wharf names them: the ones not hosted on a wharf. */
export function localGrounds(cfg: Config): string[] {
  const entries = Object.entries(cfg.grounds);
  if (entries.length === 0) return ['home'];
  return entries.filter(([, g]) => !g.wharf).map(([name]) => displayGrounds(name, cfg)).sort();
}

/** Whether a helm session holds this grounds now. */
export function helmHolds(cfg: Config, grounds: string, now = Date.now()): boolean {
  const id = storageGrounds(grounds, cfg);
  return liveHelms(cfg.helm.ttlSecs * 1000, now).some((h) => h.grounds === id);
}

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * A relayed `helm-request` call, as the local glass takes it. A new Slack
 * thread opens a helm thread; a follow-up joins it, and reopens it when the
 * helm had resolved it. The answer names the thread and says whether the
 * grounds' helm has it now (`delivered`) or it waits for one (`queued`).
 */
export function takeSlackRequest(cfg: Config, payload: unknown, now = new Date()): { status: number; body: Record<string, unknown> } {
  const wharf = cfg.glass.mirror;
  if (!wharf) return { status: 409, body: { ok: false, reason: 'This boat does not mirror to a wharf.' } };
  const p = (payload ?? {}) as Record<string, unknown>;
  const followUp = p.followUp as Record<string, unknown> | undefined;
  const valid = text(p.request, 128) && /^[A-Za-z0-9_-]+$/.test(p.request) && text(p.grounds, 128) && text(p.text, 16000) && text(p.by, 128) && text(p.at, 64)
    && (followUp === undefined || (typeof followUp === 'object' && followUp !== null && text(followUp.text, 16000) && text(followUp.at, 64)
      && (followUp.source === undefined || text(followUp.source, 64))));
  if (!valid) return { status: 400, body: { ok: false, reason: 'Invalid helm request.' } };
  const grounds = p.grounds as string, request = p.request as string;
  if (!localGrounds(cfg).includes(grounds)) return { status: 404, body: { ok: false, reason: `This boat has no local grounds ${grounds}.` } };
  try {
    let item = relayedThread(wharf, request);
    if (item && item.grounds !== grounds) return { status: 409, body: { ok: false, reason: 'This request belongs to another grounds.' } };
    item ??= startThread({ grounds, text: p.text, via: 'slack', relay: { wharf, request, by: p.by as string, sources: [] }, now });
    const source = followUp?.source as string | undefined;
    if (followUp && !(source && item.relay?.sources.includes(source))) {
      if (item.state !== 'open') item = reopenThread(item.id, now);
      item = postThread(item.id, { text: followUp.text, via: 'slack', ...(source ? { source } : {}), now });
    }
    const state = helmHolds(cfg, grounds, now.getTime()) ? 'delivered' : 'queued';
    // The wharf learns this from the answer itself.
    markThreadRelay(item.id, { told: state });
    return { status: 201, body: { ok: true, thread: item.id, state } };
  } catch (error) {
    if (error instanceof ThreadError) return { status: error.status, body: { ok: false, reason: error.message } };
    throw error;
  }
}

/** At most this many of a thread's dispatches go in one update, newest last. */
const SYNC_DISPATCHES_MAX = 20;
/** The dispatches a thread links to, linked or as its outcome, in the order they started. */
function threadDispatches(item: HelmThread): string[] {
  const linked = item.rounds.flatMap((round) => round.entries.flatMap((entry) => ('link' in entry && entry.link === 'dispatched' ? [entry.ref] : [])));
  const outcome = item.outcome?.kind === 'dispatched' && item.outcome.ref ? [item.outcome.ref] : [];
  return [...new Set([...linked, ...outcome])].slice(-SYNC_DISPATCHES_MAX);
}

/**
 * What the wharf has yet to hear about one relayed thread: that its helm has
 * it now, or that it changed (`updated`, with the dispatches it links). It
 * never carries what the helm said: Slack only gets a link to the glass.
 */
export interface SlackThreadSync {
  thread: string;
  request: string;
  delivered: boolean;
  updated: boolean;
  dispatches: string[];
  /** The thread's update sequence this sync reports. */
  seq: number;
}

/** The relayed threads from this wharf the wharf must hear about again: a helm signed on since one queued, or the thread changed. */
export function slackThreadsToSync(cfg: Config, wharf: string, now = Date.now()): SlackThreadSync[] {
  const out: SlackThreadSync[] = [];
  for (const item of listThreads()) {
    const relay = item.relay;
    if (relay?.wharf !== wharf) continue;
    const delivered = relay.told === 'queued' && item.state === 'open' && helmHolds(cfg, item.grounds, now);
    const seq = item.responseSeq ?? 0;
    const updated = seq > (relay.sentSeq ?? 0);
    if (delivered || updated) out.push({ thread: item.id, request: relay.request, delivered, updated, dispatches: updated ? threadDispatches(item) : [], seq });
  }
  return out;
}

/** Record that the wharf has heard one sync. */
export function slackThreadSynced(sync: SlackThreadSync): void {
  markThreadRelay(sync.thread, { told: 'delivered', sentSeq: sync.seq });
}
