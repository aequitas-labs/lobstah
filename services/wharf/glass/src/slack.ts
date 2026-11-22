import { useEffect, useState } from 'preact/hooks';
import { json } from './api.js';
import { html, when } from './common.js';
import { Button } from '../../../../packages/glass-ui/ui/components/button.js';

/** This person's Slack link as the wharf holds it, and the kind groups it sends. */
export interface SlackStatus {
  configured: boolean;
  kinds: string[];
  link?: { team: string; slackUser: string; linkedAt: string };
}

/** The kind groups a person can turn off, as the wharf names them. Replies to their own requests always come. */
const KINDS: Array<[kind: string, label: string]> = [
  ['decisions', 'Decisions and questions'],
  ['permissions', 'Permissions'],
  ['prs', 'PRs and reviews'],
  ['jobs', 'Jobs and reports'],
  ['notices', 'Notices'],
];

/**
 * Connect this person's own Slack to their wharf: the app's private chat
 * with them gets the cards of every boat and grounds on it, in the kinds
 * they choose. A workspace install links nobody else. Disconnecting stops
 * what is sent and keeps every card.
 */
export function SlackLinkSection(): ReturnType<typeof html> {
  const [status, setStatus] = useState<SlackStatus>(),
    [error, setError] = useState(() => new URLSearchParams(location.search).get('slack_error') ?? ''),
    [busy, setBusy] = useState(false),
    [kinds, setKinds] = useState<string[]>([]);
  const load = () =>
    json<SlackStatus>('/api/glass/slack').then(
      (next) => {
        setStatus(next);
        setKinds(next.kinds ?? []);
      },
      (e: Error) => setError(e.message),
    );
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
  const save = () =>
    run(async () => {
      await json('/api/glass/slack/kinds', { kinds });
      await load();
    });
  const disconnect = () =>
    run(async () => {
      await json('/api/glass/slack/disconnect', {});
      await load();
    });
  const changed = !!status && KINDS.some(([kind]) => kinds.includes(kind) !== (status.kinds ?? []).includes(kind));
  const toggle = (kind: string) => (event: Event) =>
    setKinds((event.currentTarget as HTMLInputElement).checked ? [...kinds, kind] : kinds.filter((k) => k !== kind));
  return html`<h2 id="slack-heading">Slack</h2>${error && html`<div class="bad" role="alert">${error}</div>`}${
    !status
      ? html`<div class="dim">checking Slack</div>`
      : !status.configured
        ? html`<div class="dim">No Slack app is configured on this wharf</div>`
        : status.link
          ? html`<div class="sub">Linked · ${when(status.link.linkedAt)}</div><fieldset disabled=${busy}><legend>Send to Slack</legend>${KINDS.map(
              ([kind, label]) =>
                html`<label key=${kind}><input type="checkbox" checked=${kinds.includes(kind)} onChange=${toggle(kind)} />${label}</label>`,
            )}</fieldset><${Button} disabled=${busy || !changed} onClick=${save}>Save<//><${Button} disabled=${busy} onClick=${disconnect}>Disconnect Slack<//>`
          : html`<div class="sub">Get your cards and send requests in a private chat with the lobstah app</div><${Button} disabled=${busy} onClick=${connect}>Connect Slack<//>`
  }`;
}
