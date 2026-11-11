import { useEffect, useState } from 'preact/hooks';
import { json } from './api.js';
import { html, when } from './common.js';

/** This person's Slack link as the wharf holds it. */
export interface SlackStatus {
  configured: boolean;
  link?: { team: string; slackUser: string; linkedAt: string };
}

/**
 * Connect this person's own Slack: the app's private chat with them gets
 * their cards. A workspace install links nobody else. Disconnecting stops
 * what is sent and keeps every card.
 */
export function SlackLinkSection() {
  const [status, setStatus] = useState<SlackStatus>(),
    [error, setError] = useState(() => new URLSearchParams(location.search).get('slack_error') ?? ''),
    [busy, setBusy] = useState(false);
  const load = () => json<SlackStatus>('/api/glass/slack').then(setStatus, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  const run = async (step: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await step();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connect = () => run(async () => location.assign((await json<{ url: string }>('/api/glass/slack/connect', {})).url));
  const disconnect = () =>
    run(async () => {
      await json('/api/glass/slack/disconnect', {});
      await load();
    });
  return html`<div class="sec">slack</div>${error && html`<div class="bad" role="alert">${error}</div>`}${
    !status
      ? html`<div class="dim">checking Slack</div>`
      : !status.configured
        ? html`<div class="dim">No Slack app is configured on this wharf</div>`
        : status.link
          ? html`<div class="sub">Your cards go to your private chat with the lobstah app · linked ${when(status.link.linkedAt)}</div><button class="btn" disabled=${busy} onClick=${disconnect}>disconnect Slack</button>`
          : html`<div class="sub">Get your cards in a private Slack chat with the lobstah app. Answers still happen here</div><button class="btn" disabled=${busy} onClick=${connect}>connect Slack…</button>`
  }`;
}
