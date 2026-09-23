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
}

export interface LobItem {
  key: string;
  text: string;
  click: string;
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
  let items: LobItem[] = att.map((x) => ({
    key: x.lane + ':' + x.id,
    text: x.note || x.verb,
    click: "showModal('dispatch','" + x.lane + ':' + x.id + "')",
  }));
  if (!items.length && opts.preview) {
    items = [{ key: 'preview', text: 'attention questions crawl in here', click: opts.previewClick }];
  }
  const extra = items.length > 4 ? items.length - 4 : 0;
  items = items.slice(0, 4);
  if (extra) items[3] = { ...items[3]!, text: '…and ' + extra + ' more — see attention' };
  return items;
}
