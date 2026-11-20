import { useEffect, useRef } from 'preact/hooks';
import { html } from '../html.js';
import { addFiles, pasteImages, removeFile, setDraft } from '../actions.js';
import { getState } from '../store.js';
import type { DecisionDraft } from '../store.js';
import { can } from '../backend.js';
import { SendHint, onSendKey, sendShortcut, touchOnly } from '../send-key.js';
import { Button, buttonClass } from './button.js';

const grow = (el: HTMLTextAreaElement) => {
  el.style.height = 'auto';
  // scrollHeight leaves out the border, which a border-box height includes.
  el.style.height = el.value ? el.scrollHeight + el.offsetHeight - el.clientHeight + 'px' : '';
};

/** The same text, attachment and Send controls in cards, messages and thread rounds. */
export function Composer({
  draftKey: key,
  draft,
  accept,
  textKey,
  label = 'Your answer',
  placeholder,
  onSend,
  hideError = false,
  done = 'Answer sent',
  allowFiles = can('answer-files'),
  autoFocus = false,
}: {
  draftKey: string;
  draft?: DecisionDraft;
  accept: string;
  textKey?: string;
  label?: string;
  placeholder?: string;
  onSend: () => Promise<string | undefined>;
  hideError?: boolean;
  done?: string;
  allowFiles?: boolean;
  /** Put the cursor in the text box once it shows, after any dialog takes focus for itself. */
  autoFocus?: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => area.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [autoFocus]);
  const text = draft?.text ?? '',
    files = draft?.files ?? [],
    sending = !!draft?.sending,
    touch = touchOnly();
  const error = hideError ? undefined : draft?.error;
  return [
    html`<div class="dcompose"><div class="danswer-wrap">${textKey && html`<kbd class="dkey dkey-text" aria-hidden="true">${textKey}</kbd>`}<textarea
      ref=${area}
      class="danswer"
      rows="2"
      aria-keyshortcuts=${textKey}
      aria-label=${label}
      placeholder=${placeholder ?? label}
      value=${text}
      disabled=${sending}
      onInput=${(e: Event) => {
        const el = e.currentTarget as HTMLTextAreaElement;
        grow(el);
        setDraft(key, { text: el.value, error: undefined });
      }}
      onPaste=${allowFiles ? (e: ClipboardEvent) => void pasteImages(key, e) : undefined}
      onKeyDown=${onSendKey(
        () => !getState().drafts[key]?.sending,
        () => void onSend(),
      )}
    ></textarea></div><div class="dtools">${
      allowFiles &&
      html`<label class=${buttonClass('icon', 'lg', 'dattach')} title="Attach images or files">${AttachIcon}<input
          type="file"
          multiple
          aria-label="Attach"
          accept=${accept}
          disabled=${sending}
          onChange=${(e: Event) => {
            const input = e.currentTarget as HTMLInputElement;
            void addFiles(key, input.files).then(() => {
              input.value = '';
            });
          }}
        /></label>`
    }${!touch && html`<${SendHint} />`}<${Button} variant="icon" size="lg" class="dsend" aria-label="Send" title="Send" aria-keyshortcuts=${sendShortcut()} disabled=${sending} action=${() => onSend()} sending="Send" preserveLabel pendingTitle="Sending…" done=${done} showError=${false}>${SendIcon}<//></div></div>`,
    (files.length > 0 || error) &&
      html`<div class="dfoot">
      ${files.map(
        (f, i) =>
          html`<span key=${f.name + i} class="dchip">${f.name}<${Button} variant="icon" class="dx" label="remove" disabled=${sending} onClick=${() => removeFile(key, i)}>×<//></span>`,
      )}
      ${error && html`<span class="bad derr">${error}</span>`}
    </div>`,
  ];
}

const AttachIcon = html`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>`;
const SendIcon = html`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>`;
