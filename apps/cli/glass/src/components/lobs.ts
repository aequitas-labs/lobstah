import { useMemo } from 'preact/hooks';
import { lobItems } from '../../../src/glass-lobs.js';
import type { LobItem } from '../../../src/glass-lobs.js';
import { hideLob, showModal } from '../actions.js';
import { html } from '../html.js';
import type { GlassState } from '../store.js';
import { PetArt } from './pet-art.js';

/**
 * The crawling lobs: attention walking along the bottom of the page.
 * prefs.lobs gates the lobs; acked items (the pet's shared ack) and lobs
 * this browser already clicked (hidden by item key + state hash) don't
 * walk; a new state re-shows them. lobItems (glass-lobs.ts) makes that
 * decision; the glass writes nothing to lobstah — the hide is localStorage.
 */

function lob(it: LobItem, i: number) {
  const style = 'animation-duration:' + ((innerWidth + 180) / (100 + i * 12)).toFixed(1) + 's;animation-delay:-' + ((i * 9) % 14) + 's';
  const hide = () => {
    if (it.hideKey) hideLob(it.hideKey, it.hideHash ?? '');
  };
  const body = [
    html`<div class="bub">${it.label && [html`<span class="badge dim">${it.label}</span>`, ' ']}<span>${it.text.length > 48 ? it.text.slice(0, 47) + '…' : it.text}</span></div>`,
    html`<${PetArt} />`,
  ];
  // A PR lob is a plain link out (read-only: the glass opens, never acts);
  // a question lob opens its dispatch modal.
  const open = it.open;
  // A decision or question goes to its card on the deck, scrolled to and flashed.
  if (it.hash)
    return html`<a key=${it.key} class="lob" style=${style} title="open the decision" href=${it.hash} onClick=${hide}>${body}</a>`;
  return it.href
    ? html`<a key=${it.key} class="lob" style=${style} title=${it.label === 'report' ? 'open the report' : 'open the PR'} href=${it.href} target="_blank" rel="noopener" onClick=${hide}>${body}</a>`
    : html`<div
        key=${it.key}
        class="lob"
        style=${style}
        title="click to open"
        onClick=${() => {
          hide();
          if (open) showModal(open.type, open.key);
        }}
      >
        ${body}
      </div>`;
}

export function Lobs({ state }: { state: GlassState }) {
  const d = state.snapshot;
  const items = lobItems(d?.attention || [], {
    lobs: state.prefs.lobs,
    hidden: state.lobHidden,
    preview: state.preview,
    previewHelm: d && d.helms.length ? d.helms[0]!.grounds : undefined,
  });
  // The lobs re-render only when which lobs walk changes, so
  // a poll never restarts their crawl.
  const key = items.map((i) => i.key).join('|');
  return useMemo(() => items.map((it, i) => lob(it, i)), [key]);
}
