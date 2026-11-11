import { acknowledgeReview, loadConfig } from '@lobstah/core';
import { currentAck, writeAck } from './acks.js';
import { isHostedKey } from './hosted-view.js';
import type { TendAttention } from './tend.js';
import { ackHostedItem } from './wharf-commands.js';

/** One acknowledgement, as the glass answers it. */
export interface WalkingAck {
  key: string;
  stateHash: string;
  at: string;
  by: string;
}

/**
 * Acknowledge one walking item where its ack lives, so the pet and every
 * glass stop walking it:
 * - a review notification: on its review, as `attention ack review:…` does;
 * - an item of a grounds on a wharf: on that wharf, so every boat agrees;
 * - anything else: this boat's ack file, the one a pet click writes.
 * An ack that already stands for this state is kept, with its time and author.
 */
export async function ackWalkingItem(item: Pick<TendAttention, 'key' | 'kind' | 'stateHash'>, by: string): Promise<WalkingAck> {
  const { key, stateHash } = item;
  if (item.kind === 'review') {
    if (!acknowledgeReview(key)) throw new Error('no such review');
    return { key, stateHash, at: new Date().toISOString(), by };
  }
  if (isHostedKey(key)) {
    const ack = await ackHostedItem(loadConfig(), key);
    return { key, stateHash, at: ack.at, by: ack.by };
  }
  const ack = currentAck(key, stateHash) ?? { key, kind: item.kind, stateHash, at: new Date().toISOString(), by };
  writeAck(ack);
  return { key, stateHash, at: ack.at, by: ack.by };
}
