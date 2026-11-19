/**
 * Which lobsters crawl the spyglass page: the pure decision behind the
 * page's Lobs component. The page's bundle imports it, so the browser and
 * the tests run the same code — keep it free of Node imports.
 */
import { presentLegacyAttention, type WatchAttentionDisplay } from '@lobstah/watch-types/presentation';
import type { ModalRef } from './glass-diff.js';

export interface LobAttention {
  id: string;
  lane: string;
  presentation?: WatchAttentionDisplay;
  verb: string;
  note?: string;
  /** A stack's short line; a lob shows it before the note. */
  headline?: string;
  /** tend's attention kind; a `pr:*` item walks as a link to its PR. */
  kind?: string;
  prUrl?: string;
  /** The PR in its review tool ([repos.<key>].review); a review lob links there. */
  reviewUrl?: string;
  /** tend's stable item key and the hash of the state it stands on. */
  key?: string;
  stateHash?: string;
  /** Acknowledged (the pet's shared ack): it doesn't walk. */
  acked?: unknown;
  quiet?: boolean;
  /** An item of a grounds on a wharf: the hosted glass at this item. */
  glass?: string;
}

export interface LobItem {
  key: string;
  text: string;
  /** The modal a lob opens in the page (a question's dispatch, a report, the preview's helm). */
  open?: ModalRef;
  /** A PR lob is a plain link out — the glass opens, never acts. */
  href?: string;
  /** A decision lob goes to its card on the deck (`#decision/<key>`). */
  hash?: string;
  /** The short kind label shown before the text (draft, review, checks, ready, landed, watch). */
  label?: string;
  /** What a click acknowledges (and hides in this browser at once): the item key and its state hash. */
  hideKey?: string;
  hideHash?: string;
}

export interface LobOptions {
  /** This browser's st.lobs preference — off means no lobs at all, preview included. */
  lobs: boolean;
  /** Lobs this browser clicked: item key → the state hash hidden. A new hash re-shows it. */
  hidden?: Record<string, string>;
  /** The ?lob page parameter: show a sample lob when nothing is waiting. */
  preview: boolean;
  /** The helm the preview lob opens, when there is one. */
  previewHelm?: string;
}

export function lobItems(att: LobAttention[], opts: LobOptions): LobItem[] {
  if (!opts.lobs) return [];
  const hidden = opts.hidden ?? {};
  let items: LobItem[] = att
    .filter((x) => !x.quiet && !x.acked && !(x.key !== undefined && hidden[x.key] === x.stateHash))
    .map((x) => {
      const display = x.presentation ?? presentLegacyAttention(x);
      const hide = display.acknowledge && x.key !== undefined ? { hideKey: x.key, hideHash: x.stateHash ?? '' } : {};
      return { key: display.itemKey, text: display.text, label: display.label, ...display.target, ...hide };

    });
  if (!items.length && opts.preview) {
    items = [{ key: 'preview', text: 'attention questions crawl in here', ...(opts.previewHelm ? { open: { type: 'helm' as const, key: opts.previewHelm } } : {}) }];
  }
  const extra = items.length > 4 ? items.length - 4 : 0;
  items = items.slice(0, 4);
  // The last lob stands for the rest: a click on it acknowledges none of them.
  if (extra) {
    const { hideKey: _key, hideHash: _hash, ...last } = items[3]!;
    items[3] = { ...last, text: '…and ' + extra + ' more — see attention', label: '' };
  }
  return items;
}
