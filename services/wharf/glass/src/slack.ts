import { useEffect, useState } from 'preact/hooks';
import { json } from './api.js';
import { html, when } from './common.js';
import { Button } from '../../../../packages/glass-ui/ui/components/button.js';

/** This person's Slack link as the wharf holds it. */
export interface SlackStatus {
  configured: boolean;
  grounds: string[];
  link?: { team: string; slackUser: string; linkedAt: string; grounds: string[] };
}

/**
 * Connect this person's own Slack: the app's private chat with them gets
 * their cards. A workspace install links nobody else. Disconnecting stops
 * what is sent and keeps every card.
 */
export function SlackLinkSection(): ReturnType<typeof html> {
  const [status, setStatus] = useState<SlackStatus>(),
    [error, setError] = useState(() => new URLSearchParams(location.search).get('slack_error') ?? ''),
    [busy, setBusy] = useState(false),
    [selectedGrounds, setSelectedGrounds] = useState<string[]>([]);
  const load = () => json<SlackStatus>('/api/glass/slack').then((next) => {
    setStatus(next);
    setSelectedGrounds(next.link?.grounds.length ? next.link.grounds : next.grounds.length === 1 ? next.grounds : []);
  }, (e: Error) => setError(e.message));
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
  const connect = () => run(async () => location.assign((await json<{ url: string }>('/api/glass/slack/connect', { grounds: selectedGrounds })).url));
  const save = () => run(async () => { await json('/api/glass/slack/grounds', { grounds: selectedGrounds }); await load(); });
  const disconnect = () =>
    run(async () => {
      await json('/api/glass/slack/disconnect', {});
      await load();
    });
  return html`<div class="sec">Slack</div>${error && html`<div class="bad" role="alert">${error}</div>`}${status?.configured && html`<fieldset disabled=${busy}><legend>Grounds for Slack</legend>${status.grounds.map((grounds) => html`<label key=${grounds}><input type="checkbox" checked=${selectedGrounds.includes(grounds)} onChange=${(event: Event) => {
    setSelectedGrounds((event.currentTarget as HTMLInputElement).checked ? [...selectedGrounds, grounds] : selectedGrounds.filter((name) => name !== grounds));
  }} />${grounds}</label>`)}${!status.grounds.length && html`<div class="dim">No grounds are available yet. Wait for a boat to publish its cards.</div>`}</fieldset>`}${
    !status
      ? html`<div class="dim">checking Slack</div>`
      : !status.configured
        ? html`<div class="dim">No Slack app is configured on this wharf</div>`
        : status.link
          ? html`<div class="sub">Slack serves ${status.link.grounds.join(', ') || 'no grounds'} · linked ${when(status.link.linkedAt)}</div><${Button} disabled=${busy || !selectedGrounds.length} onClick=${save}>Save grounds<//><${Button} disabled=${busy} onClick=${disconnect}>Disconnect Slack<//>`
          : html`<div class="sub">Choose which grounds to use from your private chat with the lobstah app</div><${Button} disabled=${busy || !selectedGrounds.length} onClick=${connect}>Connect Slack<//>`
  }`;
}
