import type { GlassPrDetails, GlassReview, GlassSnapshot } from '@lobstah/core';
import { useEffect, useState } from 'preact/hooks';
import { prModalView } from '../../src/glass-diff.js';
import { openLightbox, showModal } from '../actions.js';
import { backend } from '../backend.js';
import { html, type Children } from '../html.js';
import { Avatar, githubAvatarUrl } from './card.js';
import { DetailFrame } from './detail-frame.js';
import { Age, TrapName, reviewLink, stackNumbers } from './common.js';
import { GitHubDescription, MarkdownElements } from './markdown.js';
import { MergeWhenGreen, StatusChip } from './prs.js';
import { ReviewActions, reviewStatus } from './reviews.js';
import { LinkedText } from './links.js';

/** Shared safe Markdown for review summaries and complete findings. */
const markdown = (text: string): Children =>
  html`<${MarkdownElements} text=${text} surface="card" copyCode openImage=${openLightbox} image=${(_name: string, alt: string) => alt} />`;

/** Findings precede the PR description whenever a draft is available. */
function Findings({ review }: { review: GlassReview }) {
  const blocking = review.blocking ?? [];
  const comments = (review.comments ?? []).filter(
    (comment) =>
      !blocking.some((finding) => finding.path === comment.path && finding.line === comment.line && finding.body === comment.body),
  );
  if (!review.summary && !blocking.length && !comments.length && !review.verdict) return null;
  return html`<section class="pr-findings"><h4>Findings <span class="dim">${review.verdict?.replaceAll('_', ' ')} · ${blocking.length} blocking</span></h4>
    ${review.summary && markdown(review.summary)}
    ${[...blocking.map((finding) => ({ ...finding, severity: 'blocking' })), ...comments.map((finding) => ({ ...finding, severity: /^nit\b/i.test(finding.body) ? 'nit' : 'non-blocking' }))].map((finding) => html`<article class=${'pr-finding ' + (finding.severity === 'blocking' ? 'bad' : 'warn')}><div><span class="badge">${finding.severity}</span> <code>${finding.path}:${finding.line}</code></div>${markdown(finding.body)}</article>`)}
  </section>`;
}

/** One PR destination for cards, review drafts, lobs and the pet; opening it never sends a review acknowledgement. */
export function PrView({ snapshot, prKey }: { snapshot: GlassSnapshot; prKey: string }) {
  const p = snapshot.prs?.find((pr) => pr.key === prKey);
  const review = snapshot.reviews?.find((round) => round.key.replace('review:', 'pr:') === prKey);
  const context = p ? prModalView(snapshot, prKey) : null;
  const [loaded, setLoaded] = useState<{ key: string; data?: GlassPrDetails; error?: string }>({ key: prKey });
  useEffect(() => {
    let live = true;
    setLoaded({ key: prKey });
    const read = backend().prDetails;
    if (!read) {
      setLoaded({ key: prKey, error: 'Description is unavailable from this source.' });
      return;
    }
    void read(prKey)
      .then((result) => {
        if (live) setLoaded(result.ok ? { key: prKey, data: result.data } : { key: prKey, error: 'The PR description could not be read.' });
      })
      .catch(() => {
        if (live) setLoaded({ key: prKey, error: 'The PR description could not be read.' });
      });
    return () => {
      live = false;
    };
  }, [prKey]);
  const data = loaded.key === prKey ? loaded.data : undefined;
  const url = p?.url ?? review?.url ?? data?.url;
  if (!url) return html`<${DetailFrame} identity="PR"><p class="dim">This PR is no longer in the glass.</p><//>`;
  const repo = p?.forgeRepo ?? review?.repo ?? prKey.replace(/^pr:/, '').split('#')[0];
  const number = p?.number ?? review?.number;
  const author = data?.author?.login ?? p?.author ?? review?.author;
  const asker = review?.asker ?? review?.requestedBy;
  const authorName = author === asker ? (review?.askerName ?? author) : author;
  const avatar =
    data?.author?.avatarUrl ?? (author === asker ? review?.askerAvatarUrl : undefined) ?? (author ? githubAvatarUrl(author) : undefined);
  const identity = html`<a href=${url} target="_blank" rel="noopener">${repo}#${number}</a>`;
  const openUrl = review?.staged ? (review.stagedReviewUrl ?? review.reviewUrl) : (review?.reviewUrl ?? reviewLink(url));
  const open = html`<a class=${review?.staged ? 'btn rv-staged' : 'btn'} href=${openUrl} target="_blank" rel="noopener">${review?.staged ? 'Open draft' : review || openUrl !== url ? 'Open review' : 'Open in GitHub'}</a>`;
  const title = data?.title ?? p?.title ?? review?.title;
  const state = data?.state ?? p?.state;
  const draft = data?.draft ?? p?.draft;
  const status = review ? reviewStatus(review) : null;
  const footer = review
    ? html`<${ReviewActions} r=${review} canDraft=${review.mode !== 'notify'} publish=${review.publish ?? false} split inView />`
    : p?.mine && p.state === 'OPEN'
      ? html`<${MergeWhenGreen} p=${p} size="lg" />`
      : null;
  const decision =
    p?.reviewDecision === 'APPROVED'
      ? 'Approved'
      : p?.reviewDecision === 'CHANGES_REQUESTED'
        ? 'Changes requested'
        : p?.reviewDecision === 'REVIEW_REQUIRED'
          ? 'Review required'
          : '';
  return html`<${DetailFrame} identity=${identity} open=${open} footer=${footer}>
    <header class="pr-view-head"><h2>${LinkedText(title ?? `${repo}#${number}`)}</h2><div class="pr-view-chips">${state && StatusChip(draft ? 'Draft' : state === 'OPEN' ? 'Open' : state === 'MERGED' ? 'Merged' : 'Closed', state === 'OPEN' ? 'ok' : 'dim')}${p && StatusChip(p.badge.text, p.badge.tone ?? 'dim')}${p?.mine && StatusChip('yours', 'dim')}${p?.gate && StatusChip(p.gate, 'warn')}${status && StatusChip(status.word, status.tone)}${review?.needsYou && StatusChip('needs you', 'bad')}</div>
    ${author && html`<div class=${'pr-view-person' + (asker === author ? ' rv-person' : '')}><${Avatar} url=${avatar} name=${authorName ?? author} size=${20} /><b>${authorName}</b>${review && html`<span class="dim"> · ${asker === author ? 'asked for your review' : html`review asked by <span class="rv-person"><${Avatar} url=${review.askerAvatarUrl ?? (asker ? githubAvatarUrl(asker) : undefined)} name=${review.askerName ?? asker ?? ''} size=${20} />${review.askerName ?? asker ?? 'someone'}${review.automatic && html`<span class="badge" title="A bot re-requested this review">automatic</span>`}</span>`} ${review.automatic && asker === author && ' (automatic)'} ${Age(review.requestedAt)} ago</span>`}</div>`}
    ${(data?.headRefName ?? p?.headRefName) && html`<div class="sub">${data?.headRefName ?? p?.headRefName} → ${data?.baseRefName ?? p?.baseRefName}${(data?.updatedAt ?? p?.updatedAt) && html` · updated ${Age(data?.updatedAt ?? p?.updatedAt)} ago`}</div>`}</header>
    ${review?.reason && html`<p class="dim">${review.reason}</p>`}
    ${review && html`<${Findings} review=${review} />`}
    <section><h4>Description</h4><div class="pr-description">${data ? (data.bodyHtml ? html`<${GitHubDescription} source=${data.bodyHtml} openImage=${openLightbox} />` : html`<span class="dim">No description.</span>`) : html`<span class="dim">${loaded.key === prKey && loaded.error ? loaded.error : 'Loading description…'}</span>`}</div></section>
    ${p && html`<section><h4>Checks <span class="dim">${p.checks.passed} passed · ${p.checks.pending} pending</span></h4>${p.failingChecks?.map((check) => html`<div class="pr-check"><span class="badge bad">failed</span> ${check.detailsUrl ? html`<a href=${check.detailsUrl} target="_blank" rel="noopener">${check.name}</a>` : check.name}</div>`)}${!p.failingChecks?.length && p.checks.failed > 0 && html`<div class="bad">${p.checks.failed} failed</div>`}</section>`}
    ${p && (decision || (p.review?.unresolvedThreads ?? 0) > 0) && html`<section><h4>Reviews</h4><div>${decision}${(p.review?.unresolvedThreads ?? 0) > 0 && ` · ${p.review?.unresolvedThreads ?? 0} unresolved threads`}${p.review && p.review.unresolvedThreads === 0 && ' · no unresolved threads'}</div></section>`}
    ${
      context?.chain.length
        ? html`<section><h4>Dispatch</h4>${context.chain.map((item) => {
            const dispatch = snapshot.dispatches.find((dispatch) => dispatch.id === item.id);
            const trap = dispatch?.claimedBy?.startsWith('wt:') ? dispatch.claimedBy.slice(3) : undefined;
            return html`<div>${
              item.culled
                ? `${item.id.slice(0, 8)} (culled)`
                : html`<a href="#" onClick=${(event: Event) => {
                    event.preventDefault();
                    showModal('dispatch', item.modalKey!);
                  }}>${item.id.slice(0, 8)}</a>`
            } <span class="dim">${item.verb}</span>${trap && html` · ${TrapName(trap)}`}</div>`;
          })}</section>`
        : null
    }
    ${context?.stack && html`<section><h4>Stack</h4><div>${stackNumbers(context.stack.numbers, new Map(context.stack.numbers.map((n, i) => [n, context.stack!.titles[i]])), p?.number)} · ${context.stack.position} of ${context.stack.size} · base ${context.stack.floor}${context.stack.nextMergeable ? ' · next mergeable' : context.stack.blockedBy ? ` · waiting for #${context.stack.blockedBy}` : ''}</div></section>`}
    ${context?.watch && html`<section><h4>Watch</h4><div>${context.watch.owner}${context.watch.lastCheckedAt && html` · checked ${Age(context.watch.lastCheckedAt)} ago`}</div>${context.watch.lastError && html`<div class="bad">${LinkedText(context.watch.lastError)}</div>`}</section>`}
  <//>`;
}
