import { useEffect, useState } from 'preact/hooks';
import { messageTrap, readTrapPane } from '../actions.js';
import { html } from '../html.js';

/** How often an open modal re-reads the pane. */
const PANE_POLL_MS = 2000;

/** A read-only view of a live tmux trap's screen. It polls only while mounted, so only while its modal is open. */
export function TrapPane({ trapId }: { trapId: string }) {
  const [screen, setScreen] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let closed = false;
    const read = async () => {
      if (document.hidden) return;
      const next = await readTrapPane(trapId);
      if (closed) return;
      setScreen(next);
      setLoaded(true);
    };
    void read();
    const timer = setInterval(() => void read(), PANE_POLL_MS);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [trapId]);
  if (screen !== undefined) return html`<pre class="trappane" aria-label="This trap's screen">${screen}</pre>`;
  return html`<div class="dim">${loaded ? 'The pane could not be read' : 'Reading the pane'}</div>`;
}

/** Send a live trap a message from its modal, as `lobstah send` would. */
export function TrapMessageBox({ trapId }: { trapId: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const failed = await messageTrap(trapId, text);
    setSending(false);
    setError(failed);
    if (!failed) setText('');
  };
  return html`<div class="trapmessage">
    <textarea
      class="danswer"
      rows="2"
      aria-label="Message this trap"
      placeholder="Message this trap"
      value=${text}
      disabled=${sending}
      onInput=${(e: Event) => setText((e.currentTarget as HTMLTextAreaElement).value)}
    ></textarea>
    <button class="btn" disabled=${sending || !text.trim()} onClick=${() => void send()}>${sending ? 'Sending' : 'Send'}</button>
    ${error && html`<span class="bad"> ${error}</span>`}
  </div>`;
}
