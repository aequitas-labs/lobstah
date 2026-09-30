import { closeLightbox } from '../actions.js';
import { html } from '../html.js';
import type { Lightbox } from '../store.js';

/**
 * The in-page image overlay: every image in the glass (decision cards,
 * report pages, attachments) opens here instead of a new window. The image
 * is centered at up to 90% of the viewport over a dark backdrop. Escape, a
 * click on the backdrop, or the close button closes it; a link opens the
 * original file.
 */
export function LightboxView({ box }: { box: Lightbox | null }) {
  if (!box) return null;
  const onBackdrop = (e: Event) => {
    if (e.target === e.currentTarget) closeLightbox();
  };
  return html`<div id="lightbox" class="lightbox" role="dialog" aria-label=${box.name} onClick=${onBackdrop}>
    <button type="button" class="lbclose" title="close" onClick=${closeLightbox}>×</button>
    <img class="lbimg" src=${box.src} alt=${box.name} />
    <a class="lboriginal" href=${box.src} target="_blank" rel="noopener">open original · ${box.name}</a>
  </div>`;
}
