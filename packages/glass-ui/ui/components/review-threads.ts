import type { GlassReview } from '@lobstah/core';
import { html } from '../html.js';
import { Age } from './common.js';
import { StatusChip } from './prs.js';

/** Your threads lobstah resolved after a draft found them fixed: which one, why, and when. */
export function ResolvedThreads({ review }: { review: GlassReview }) {
  if (!review.threadHistory?.length) return null;
  return html`<section class="pr-findings" aria-label="Resolved threads">
    <h4>Resolved threads</h4>
    ${review.threadHistory.map(
      (entry) =>
        html`<article class=${'pr-finding' + (entry.failed ? ' bad' : '')} data-resolved-thread=${entry.id}>
          <div>
            ${entry.failed ? StatusChip('not resolved', 'bad') : StatusChip('resolved', 'dim')}${' '}
            <a href=${entry.url} target="_blank" rel="noopener"><code>${entry.path}${entry.line ? `:${entry.line}` : ''}</code></a>
            <span class="dim"> · ${Age(entry.at)} ago</span>
          </div>
          <div>${entry.reason}</div>
          ${entry.failed && html`<div class="bad">${entry.failed}. Resolve it on GitHub.</div>`}
        </article>`,
    )}
  </section>`;
}
