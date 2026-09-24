import type { GlassSnapshot, TendAttention } from '@lobstah/core';
import { lobItems } from '../../../src/glass-lobs.js';
import type { LobItem } from '../../../src/glass-lobs.js';
import { esc, html, raw } from '../html.js';
import type { Html } from '../html.js';
import { lobHidden, st } from '../prefs.js';

/**
 * The crawling lobs: attention walking along the bottom of the page.
 * st.lobs gates the lobs; acked items (the pet's shared ack) and lobs this
 * browser already clicked (hidden by item key + state hash) don't walk; a
 * new state re-shows them. lobItems (glass-lobs.ts) makes that decision;
 * the glass writes nothing to lobstah — the hide is localStorage.
 */

/** null until the sprite probe settles; false falls back to the waddling emoji. */
let spriteOk: boolean | null = null;
/** The rendered lobs' identity: a matching key leaves the crawling nodes alone. */
let lobKey = '';

export const resetLobs = (): void => {
  lobKey = '';
};

/** Probe the sprite once; either way, re-render the lobs. */
export function probeSprite(rerender: () => void): void {
  const i = new Image();
  i.onload = () => {
    spriteOk = true;
    lobKey = '';
    rerender();
  };
  i.onerror = () => {
    spriteOk = false;
    lobKey = '';
    rerender();
  };
  i.src = '/lob-sprite.png';
}

const hideCall = (it: LobItem): string =>
  it.hideKey ? 'hideLob(' + esc(JSON.stringify(it.hideKey)).replace(/'/g, '&#39;') + ',' + esc(JSON.stringify(it.hideHash)) + ');' : '';

function lob(it: LobItem, i: number): Html {
  const style = raw(
    'animation-duration:' + ((innerWidth + 180) / (100 + i * 12)).toFixed(1) + 's;animation-delay:-' + ((i * 9) % 14) + 's',
  );
  const label = it.label && html`<span class="badge dim">${it.label}</span> `;
  const text = it.text.length > 48 ? it.text.slice(0, 47) + '…' : it.text;
  const sprite = spriteOk === false ? raw('<span class="fallback">🦞</span>') : raw('<div class="sprite"></div>');
  const body = html`<div class="bub">${label}<span>${text}</span></div>${sprite}<img class="star" src="/star.png" alt="" onerror="this.remove()">`;
  return it.href
    ? html`<a class="lob" style="${style}" title="open the PR" href="${it.href}" target="_blank" rel="noopener" onclick="${raw(hideCall(it))}">${body}</a>`
    : html`<div class="lob" style="${style}" title="click to open" onclick="${raw(hideCall(it) + (it.click || ''))}">${body}</div>`;
}

export function renderLobs(att: TendAttention[], last: GlassSnapshot | undefined): void {
  const items = lobItems(att, {
    lobs: st.lobs,
    hidden: lobHidden,
    preview: new URLSearchParams(location.search).has('lob'),
    previewClick: last && last.helms.length ? "showModal('helm','" + last.helms[0]!.grounds + "')" : '',
  });
  const key = items.map((i) => i.key).join('|') + (spriteOk === null ? '?' : spriteOk ? 's' : 'e');
  if (key === lobKey) return;
  lobKey = key;
  // A PR lob is a plain link out (read-only: the glass opens, never acts);
  // a question lob opens its dispatch modal.
  document.getElementById('lobs')!.innerHTML = items.map((it, i) => lob(it, i).value).join('');
}
