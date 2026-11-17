import type { GlassMessage, WorkerMetadata } from '@lobstah/core';
import { html, type Children } from '../html.js';
import { Age, attachmentRows } from './common.js';
import { HarnessIcon, harnessLabel } from './harness-icon.js';
import { LinkedText } from './links.js';

export const Ago = (at: string | undefined): Children => at && html`${Age(at)} ago`;

/** Metadata shares centered items and separators wherever it appears. */
export function MetaLine({ items, class: cls = 'view-meta' }: { items: Children[]; class?: string }): Children {
  const parts = items.filter(Boolean);
  return html`<span class=${'meta-line ' + cls}>${parts.flatMap((part, index) => [
    index > 0 && html`<span class="meta-separator" aria-hidden="true"> · </span>`,
    html`<span class="meta-item">${part}</span>`,
  ])}</span>`;
}

/** Known harness, model and mode; older records omit fields they never observed. */
export function WorkerLine({ worker }: { worker: Partial<WorkerMetadata> }): Children {
  return html`<${MetaLine} class="view-worker" items=${[
    worker.harness && html`<${HarnessIcon} harness=${worker.harness} /> ${harnessLabel(worker.harness)}`,
    worker.model,
    worker.config?.permissionMode,
    worker.config?.effort,
  ]} />`;
}

/** Existing mail envelopes, with their delivery receipts and sender, newest first. */
export function ViewMessages({ messages, file }: { messages: GlassMessage[]; file: (name: string) => string }) {
  if (!messages.length) return null;
  return html`<section class="view-messages"><h4>Messages</h4>${[...messages].reverse().map((message) => html`<article class="msg"><div class="hdr">${message.from !== 'unknown' && `from ${message.from} · `}<span class=${message.state === 'pending' ? 'warn' : 'ok'}>${message.state}</span>${message.at && html` · ${Ago(message.at)}`}</div><div>${LinkedText(message.text)}</div>${message.attachments?.length ? attachmentRows(message.attachments, file) : null}</article>`)}</section>`;
}
