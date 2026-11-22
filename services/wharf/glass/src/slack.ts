import { useEffect, useState } from 'preact/hooks';
import { json } from './api.js';
import { html, when } from './common.js';
import { Button } from '../../../../packages/glass-ui/ui/components/button.js';

/** This person's Slack link as the wharf holds it. */
export interface SlackStatus {
  configured: boolean;
  link?: { team: string; slackUser: string; linkedAt: string };
}

/**
 * Connect this person's own Slack to their wharf: the app's private chat
 * with them gets the cards of every boat and grounds on it. A workspace
 * install links nobody else. Disconnecting stops what is sent and keeps
 * every card.
 */
export function SlackLinkSection(): ReturnType<typeof html> {
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
  return html`<h2 id="slack-heading">Slack</h2>${error && html`<div class="bad" role="alert">${error}</div>`}${
    !status
      ? html`<div class="dim">checking Slack</div>`
      : !status.configured
        ? html`<div class="dim">No Slack app is configured on this wharf</div>`
        : status.link
          ? html`<div class="sub">Linked · ${when(status.link.linkedAt)}</div><${Button} disabled=${busy} onClick=${disconnect}>Disconnect Slack<//>`
          : html`<div class="sub">Get your cards and send requests in a private chat with the lobstah app</div><${Button} disabled=${busy} onClick=${connect}>Connect Slack<//>`
  }`;
}
