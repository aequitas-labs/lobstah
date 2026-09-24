/**
 * Which lobsters crawl the spyglass page: the pure decision behind the
 * page's Lobs component. The page's bundle imports it, so the browser and
 * the tests run the same code — keep it free of Node imports.
 */

export interface LobAttention {
  id: string;
  lane: string;
  verb: string;
  note?: string;
  /** tend's attention kind; a `pr:*` item walks as a link to its PR. */
  kind?: string;
  prUrl?: string;
  /** tend's stable item key and the hash of the state it stands on. */
  key?: string;
  stateHash?: string;
  /** Acknowledged (the pet's shared ack): it doesn't walk. */
  acked?: unknown;
}

export interface LobItem {
  key: string;
  text: string;
  /** The modal a lob opens in the page (a question's dispatch, the preview's helm). */
  open?: { type: 'dispatch' | 'helm'; key: string };
  /** A PR lob is a plain link out — the glass opens, never acts. */
  href?: string;
  /** The short kind label shown before the text (draft, review, checks, ready, landed, watch). */
  label?: string;
  /** For the per-browser hide a click records: the item key and its state hash. */
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
  // The same labels the attention table and the desktop pet use.
  const labels: Record<string, string> = {
    'pr:draft': 'draft',
    'pr:review': 'review',
    'pr:checks': 'checks',
    'pr:conflict': 'conflicts',
    'pr:ready': 'ready',
    landed: 'landed',
    watch: 'watch',
  };
  const hidden = opts.hidden ?? {};
  let items: LobItem[] = att
    .filter((x) => !x.acked && !(x.key !== undefined && hidden[x.key] === x.stateHash))
    .map((x) => {
      const label = labels[x.kind ?? ''] ?? '';
      const hide = x.key !== undefined ? { hideKey: x.key, hideHash: x.stateHash ?? '' } : {};
      return typeof x.kind === 'string' && x.kind.startsWith('pr:') && x.prUrl
        ? { key: x.kind + ':' + (x.key ?? x.prUrl), text: x.note || x.kind, href: x.prUrl, label, ...hide }
        : {
            key: (x.kind ?? 'question') + ':' + (x.key ?? x.lane + ':' + x.id),
            text: x.note || x.verb,
            label,
            ...(x.kind === 'watch' ? {} : { open: { type: 'dispatch' as const, key: x.lane + ':' + x.id } }),
            ...hide,
          };
    });
  if (!items.length && opts.preview) {
    items = [{ key: 'preview', text: 'attention questions crawl in here', ...(opts.previewHelm ? { open: { type: 'helm' as const, key: opts.previewHelm } } : {}) }];
  }
  const extra = items.length > 4 ? items.length - 4 : 0;
  items = items.slice(0, 4);
  if (extra) items[3] = { ...items[3]!, text: '…and ' + extra + ' more — see attention', label: '' };
  return items;
}
