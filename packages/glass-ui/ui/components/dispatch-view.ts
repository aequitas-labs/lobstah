import type { GlassDispatch, GlassDispatchSummary, GlassMessage, GlassSnapshot } from '@lobstah/core';
import { useState } from 'preact/hooks';
import { dispatchReport, type DispatchDetail, trapView } from '../../src/glass-diff.js';
import { cancelJob, copyText, openLightbox } from '../actions.js';
import { can, capabilities, fileUrl } from '../backend.js';
import { html } from '../html.js';
import { Button } from './button.js';
import { CardLink, SplitButton } from './card.js';
import {
  ActivityLine,
  WaitingLine,
  cmdRow,
  ImageThumb,
  attachmentRows,
  NamedText,
  TrapName,
  trapRoutes,
  viewerHasTerminal,
  reviewLink,
} from './common.js';
import { DetailFrame } from './detail-frame.js';
import { Ago, WorkerLine, ViewMessages } from './detail-parts.js';
import { Dialog } from './dialog.js';
import { LinkedText } from './links.js';
import { MarkdownElements } from './markdown.js';
import { prCard, prShapedCard, StatusChip } from './prs.js';
import { reportCard } from './reports.js';
import { isIconVerb, VerbIcon, VERB_TONE } from './run-status.js';

/** A dispatch's current work, its outputs and brief, then its history. */
export function DispatchView({
  snapshot,
  dispatch: x,
  detail,
}: {
  snapshot: GlassSnapshot;
  dispatch: GlassDispatchSummary | GlassDispatch;
  detail?: DispatchDetail | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const full = 'brief' in x ? x : undefined;
  const address = x.claimedBy ?? x.for;
  const trapId = address?.replace(/^wt:/, '');
  const rawTrap = snapshot.traps.find((trap) => trap.trapId === trapId);
  const trap = rawTrap && trapView(snapshot, rawTrap);
  const worker = x.worker ?? trap;
  const route = trap && trapRoutes(trap)[0];
  const attach = trap?.attachCommand ?? `lobstah attach ${x.id}`;
  const copy = (text: string) => async () => ((await copyText(text)) ? undefined : 'Could not copy. Use the command in Details.');
  const open = route
    ? route.control(route.name)
    : capabilities().daemon && viewerHasTerminal()
      ? html`<${Button} action=${copy(attach)} done="Attach command copied">Open session<//>`
      : null;
  const top =
    can('cancel') && x.bucket !== 'done'
      ? html`<${SplitButton} main=${open} more=${[{ label: 'Cancel dispatch…', onClick: () => setConfirming(true) }]} />`
      : open;
  const urls = new Set(
    [x.evidence?.prUrl, ...(x.evidence?.prUrls ?? []), x.evidence?.pr?.url, ...(x.prList ?? []).map((pr) => pr.url)].filter(Boolean),
  );
  const prs = snapshot.prs.filter((pr) => pr.dispatchIds.includes(x.id) || urls.has(pr.url));
  const report = dispatchReport(snapshot, x);
  const log = [...(full?.log ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const started = log.at(-1)?.at;
  const unobserved = [...urls].filter((url): url is string => !!url && !prs.some((pr) => pr.url === url));
  const files = (name: string) => fileUrl({ kind: 'dispatch', lane: x.lane, id: x.id }, name);
  const messages: GlassMessage[] =
    full?.messages ??
    (full?.inbox ?? []).map((text, i, all) => ({
      file: String(i),
      text,
      state: 'pending',
      from: i === all.length - 1 ? (x.awaitingReply?.from ?? 'unknown') : 'unknown',
      at: i === all.length - 1 ? (x.awaitingReply?.sentAt ?? '') : '',
    }));
  if (x.awaitingReply && !messages.some((message) => message.text.startsWith(x.awaitingReply!.line)))
    messages.push({
      file: 'awaiting-reply',
      text: x.awaitingReply.line,
      from: x.awaitingReply.from,
      at: x.awaitingReply.sentAt,
      state: 'pending',
    });
  const details = !!(
    x.worktree ||
    x.transcript ||
    (capabilities().daemon && viewerHasTerminal()) ||
    x.branch ||
    x.lastCommit ||
    x.followUp
  );
  return html`<${DetailFrame} identity=${html`<span>${x.repo && `${x.repo} · `}<${Button} class="copy-id" action=${copy(x.id)} done="Dispatch ID copied" title=${x.id}>${x.id.slice(0, 8)}<//></span>`} open=${top}>
    <header class="pr-view-head"><h2>${LinkedText(x.title || x.id.slice(0, 8))}</h2><div class="pr-view-chips">${StatusChip(x.verb, isIconVerb(x.verb) ? VERB_TONE[x.verb] : 'dim')}${StatusChip(x.lane, 'dim')}${x.waiting && StatusChip(`waiting on ${x.waiting.on}`, 'dim')}</div><div class="view-meta">${trapId && html`${TrapName(trapId)} · `}${worker && html`<${WorkerLine} worker=${worker} />`}${started && html` · started ${Ago(started)}`}</div></header>
    ${(x.note || x.activity || x.waiting) && html`<section class="dispatch-now"><h4>Now <span class="dim">${Ago(x.note ? x.verbAt : (x.activity?.at ?? x.waiting?.since))}</span></h4>${x.note && html`<div class="loglines">${NamedText(x.note)}</div>`}${ActivityLine(x)}${WaitingLine(x, true)}</section>`}
    ${
      (prs.length > 0 || unobserved.length > 0) &&
      html`<section class="dispatch-prs"><h4>PRs</h4><div class="detail-cards">${prs.map((pr) => prCard(pr, { attention: snapshot.attention }))}${unobserved.map(
        (url) => {
          const ref = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
          if (!ref) return null;
          return prShapedCard({
            key: url,
            title: `#${ref[2]}`,
            status: [],
            tone: 'dim',
            repo: ref[1]!,
            number: Number(ref[2]),
            actions: html`<${CardLink} href=${reviewLink(url)} />`,
            onClick: () => window.open(reviewLink(url), '_blank', 'noopener'),
          });
        },
      )}</div></section>`
    }
    ${report && html`<section class="dispatch-report"><h4>Report</h4>${reportCard(report)}</section>`}
    ${full?.brief && html`<section class="dispatch-brief"><h4>Brief</h4><div class="md"><${MarkdownElements} text=${full.brief} surface="card" copyCode openImage=${openLightbox} image=${(name: string, alt: string) => ImageThumb(files(name), alt, 'mdimg')} /></div>${full.attachments.length > 0 && attachmentRows(full.attachments, files)}</section>`}
    ${!full && html`<p class=${detail?.error ? 'bad' : 'dim'}>${detail?.error ?? 'Loading dispatch…'}</p>`}
    ${full?.log.length && html`<section class="dispatch-activity"><h4>Activity</h4>${log.map((entry) => html`<article class="view-event"><div>${isIconVerb(entry.verb) && html`<${VerbIcon} verb=${entry.verb} at=${entry.at} waitingOn=${entry.waitingOn} />`} <b>${entry.verb}</b><span class="dim"> · ${Ago(entry.at)}</span></div>${entry.note && html`<div class="loglines">${NamedText(entry.note)}</div>`}${entry.link && html`<div>${LinkedText(entry.link)}</div>`}</article>`)}</section>`}
    <${ViewMessages} messages=${messages} file=${files} />
    ${full && full.messageAttachments.length > 0 && html`<section><h4>Message attachments</h4>${attachmentRows(full.messageAttachments, files)}</section>`}
    ${details && html`<details class="view-details"><summary>Details</summary>${x.worktree && html`<h4>Worktree</h4>${cmdRow(x.worktree)}`}${capabilities().daemon && viewerHasTerminal() && html`<h4>Attach</h4>${cmdRow(attach)}`}${x.transcript && html`<h4>Transcript</h4>${cmdRow(x.transcript)}`}${x.branch && html`<h4>Branch</h4>${cmdRow(x.branch)}`}${x.lastCommit && html`<h4>Last commit</h4>${cmdRow(x.lastCommit)}`}${x.followUp && html`<p class="dim">Continues ${x.followUp.slice(0, 8)}</p>`}</details>`}
    ${
      confirming &&
      html`<${Dialog} title="Cancel dispatch" onClose=${() => setConfirming(false)}><p>Cancel this dispatch? Its worker stops.</p><div class="dialog-actions"><${Button} onClick=${() => setConfirming(false)}>Keep dispatch<//><${Button} variant="danger" sending="Cancelling…" done="Dispatch cancelled" action=${async () => {
        const why = await cancelJob(x.id);
        if (!why) setConfirming(false);
        return why;
      }}>Cancel dispatch<//></div><//>`
    }
  <//>`;
}
