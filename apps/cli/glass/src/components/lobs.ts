import type { GlassSnapshot } from '@lobstah/core';
import { useMemo } from 'preact/hooks';
import { lobItems } from '../../../src/glass-lobs.js';
import type { LobItem } from '../../../src/glass-lobs.js';
import { hideLob, showModal } from '../actions.js';
import { html } from '../html.js';
import type { GlassState } from '../store.js';

/**
 * The crawling lobs: attention walking along the bottom of the page.
 * prefs.lobs gates the lobs; acked items (the pet's shared ack) and lobs
 * this browser already clicked (hidden by item key + state hash) don't
 * walk; a new state re-shows them. lobItems (glass-lobs.ts) makes that
 * decision; the glass writes nothing to lobstah — the hide is localStorage.
 */

/** The star ornament failed to load once: no lob shows it again. */
let starOk = true;

function lob(it: LobItem, i: number, spriteOk: boolean | null) {
  const style = 'animation-duration:' + ((innerWidth + 180) / (100 + i * 12)).toFixed(1) + 's;animation-delay:-' + ((i * 9) % 14) + 's';
  const hide = () => {
    if (it.hideKey) hideLob(it.hideKey, it.hideHash ?? '');
  };
  const body = [
    html`<div class="bub">${it.label && [html`<span class="badge dim">${it.label}</span>`, ' ']}<span>${it.text.length > 48 ? it.text.slice(0, 47) + '…' : it.text}</span></div>`,
    spriteOk === false ? html`<span class="fallback">🦞</span>` : html`<div class="sprite"></div>`,
    starOk &&
      html`<img
        class="star"
        src="/star.png"
        alt=""
        onError=${(e: Event) => {
          starOk = false;
          (e.currentTarget as HTMLElement).remove();
        }}
      />`,
  ];
  // A PR lob is a plain link out (read-only: the glass opens, never acts);
  // a question lob opens its dispatch modal.
  const open = it.open;
  return it.href
    ? html`<a key=${it.key} class="lob" style=${style} title="open the PR" href=${it.href} target="_blank" rel="noopener" onClick=${hide}>${body}</a>`
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
  // The lobs re-render only when which lobs walk (or the sprite) changes, so
  // a poll never restarts their crawl.
  const key = items.map((i) => i.key).join('|') + (state.spriteOk === null ? '?' : state.spriteOk ? 's' : 'e');
  return useMemo(() => items.map((it, i) => lob(it, i, state.spriteOk)), [key]);
}
