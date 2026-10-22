import { QUIET_NOTICE_KINDS } from '@lobstah/core';
import type { Notice, ReplyEvent, WatchAttention } from '@lobstah/core';
import type { NotifyEvent } from '@lobstah/supervisor';
import type { Digest } from './digest.js';

const statusKey = (id: string, verb: string, at: string) => JSON.stringify(['status', id, verb, at]);

/** Keys identify the news, not its re-delivery time or an informational digest. */
export function helmWakeKeys(batch: {
  events?: readonly NotifyEvent[];
  watches?: readonly WatchAttention[];
  notices?: readonly Notice[];
  replies?: readonly ReplyEvent[];
}): string[] {
  return [
    ...(batch.events ?? []).filter(e => e.entry.verb !== 'working').map(e => statusKey(e.id, e.entry.verb, e.entry.at)),
    ...(batch.watches ?? []).flatMap(w => w.events.map(e => JSON.stringify(['watch', w.watch.key, e.seq]))),
    ...(batch.notices ?? []).filter(n => !n.quiet && !QUIET_NOTICE_KINDS.includes(n.kind))
      .map(n => JSON.stringify(['notice', n.kind, n.refId, n.stateHash ?? n.seq])),
    // A working reply to an explicit send is news; routine working progress is not.
    ...(batch.replies ?? []).map(r => JSON.stringify(['reply', r.id, r.entry.at])),
  ];
}

/** Quiet trap lifecycle and changing counts are not actionable wake events. */
export function digestWakeKeys(d: Digest): string[] {
  return [
    ...d.landed.map(e => statusKey(e.id, e.verb, e.at)),
    ...d.arisen.filter(e => e.at !== undefined).map(e => statusKey(e.id, e.verb, e.at!)),
  ];
}
