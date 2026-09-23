/**
 * Which lobsters crawl the spyglass page: the pure decision behind the
 * page's renderLobs. Its compiled source is embedded verbatim in the page
 * (lobItems.toString()), so the browser and the tests run the same code —
 * keep it self-contained: no imports, no closures, plain JS once compiled.
 */

export interface LobAttention {
  id: string;
  lane: string;
  verb: string;
  note?: string;
  /** tend's attention kind; a `pr:*` item walks as a link to its PR. */
  kind?: string;
  prUrl?: string;
}

export interface LobItem {
  key: string;
  text: string;
  /** onclick for a lob that opens something in the page (a modal). */
  click?: string;
  /** A PR lob is a plain link out — the glass opens, never acts. */
  href?: string;
  /** The short kind label shown before the text (draft, review, checks, ready, landed, watch). */
  label?: string;
}

export interface LobOptions {
  /** This browser's st.lobs preference — off means no lobs at all, preview included. */
  lobs: boolean;
  /** The ?lob page parameter: show a sample lob when nothing is waiting. */
  preview: boolean;
  /** onclick for the preview lob (opens the helm when there is one). */
  previewClick: string;
}

export function lobItems(att: LobAttention[], opts: LobOptions): LobItem[] {
  if (!opts.lobs) return [];
  // The same labels the attention table and the desktop pet use.
  const labels: Record<string, string> = {
    'pr:draft': 'draft',
    'pr:review': 'review',
    'pr:checks': 'checks',
    'pr:ready': 'ready',
    landed: 'landed',
    watch: 'watch',
  };
  let items: LobItem[] = att.map((x) => {
    const label = labels[x.kind ?? ''] ?? '';
    return typeof x.kind === 'string' && x.kind.startsWith('pr:') && x.prUrl
      ? { key: x.kind + ':' + x.prUrl, text: x.note || x.kind, href: x.prUrl, label }
      : {
          key: (x.kind ?? 'question') + ':' + x.lane + ':' + x.id,
          text: x.note || x.verb,
          label,
          click: x.kind === 'watch' ? '' : "showModal('dispatch','" + x.lane + ':' + x.id + "')",
        };
  });
  if (!items.length && opts.preview) {
    items = [{ key: 'preview', text: 'attention questions crawl in here', click: opts.previewClick }];
  }
  const extra = items.length > 4 ? items.length - 4 : 0;
  items = items.slice(0, 4);
  if (extra) items[3] = { ...items[3]!, text: '…and ' + extra + ' more — see attention', label: '' };
  return items;
}
