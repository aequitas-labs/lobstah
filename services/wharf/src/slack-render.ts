import type { GlassCard, GlassCardAction } from '../../../packages/core/src/backend-model.js';

/** Slack's own limits, and the plan's tighter budget inside them. */
export const SLACK_BUDGET = {
  blocks: 12,
  title: 150,
  context: 300,
  section: 2400,
  fallback: 3500,
  buttonLabel: 75,
  linkButtons: 4,
} as const;
const EXCERPT = '\n_Excerpt · read the full card in the glass_';

/** One Slack Block Kit block, as this renderer builds them. */
export type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string; emoji: false } }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'actions'; elements: Array<{ type: 'button'; text: { type: 'plain_text'; text: string; emoji: false }; url: string; action_id: string }> };
/** A chat.postMessage or chat.update body, less its channel and timestamp. */
export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
  unfurl_links: false;
  unfurl_media: false;
}

/**
 * Slack mrkdwn treats `&`, `<` and `>` as control characters: `<@U1>`,
 * `<!channel>` and `<url|label>` are mentions and links. Untrusted text is
 * escaped so a title or note can never mention anyone or forge a link.
 */
export function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Cut at a boundary: a paragraph, a line, or a word, never inside one when there is room to avoid it. */
export function trimAtBoundary(s: string, max: number): { text: string; omitted: number } {
  if (s.length <= max) return { text: s, omitted: 0 };
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' '));
  const text = (cut > max / 2 ? head.slice(0, cut) : head).trimEnd();
  return { text, omitted: s.length - text.length };
}
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
/** Text cut to fit `max` with the excerpt notice, saying how much was left out. */
function fitted(s: string, max: number): string {
  if (s.length <= max) return s;
  const notice = (omitted: number) => `${EXCERPT} (${omitted} characters not shown)`;
  const trimmed = trimAtBoundary(s, max - notice(s.length).length);
  return `${trimmed.text}${notice(trimmed.omitted)}`;
}
/** A time Slack shows in the reader's own zone, with a plain fallback. */
const slackTime = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${iso}>` : '';
};

const FAMILY_LABEL: Record<GlassCard['family'], string> = {
  decision: 'Decision', question: 'Question', permission: 'Permission', dispatch: 'Job', landed: 'Landed', pr: 'PR', stack: 'Stack',
  review: 'Review', report: 'Report', notice: 'Notice', trap: 'Trap', boat: 'Boat', request: 'Request',
};
/** How the card stands, for its context line. */
function standing(card: GlassCard): string {
  const t = card.terminal;
  // The time comes before free text, so clipping a long outcome never cuts its markup.
  if (t) return [t.state[0]!.toUpperCase() + t.state.slice(1), slackTime(t.at), t.outcome && slackEscape(t.outcome), t.by && `by ${slackEscape(t.by)}`].filter(Boolean).join(' · ');
  if (card.seen) return `Seen by ${slackEscape(card.seen.by)}`;
  return card.quiet ? 'In progress' : 'Waiting for you';
}
/** What a card offers, said in words: in this release every answer is made in the glass. */
function offered(actions: GlassCardAction[]): string[] {
  const options = actions.flatMap((a) => (a.kind === 'answer' ? [a.option] : []));
  const lines = options.map((o, i) => `${i + 1}. ${slackEscape(o)}`);
  if (actions.some((a) => a.kind === 'answer-text')) lines.push(options.length ? 'Or answer in your own words.' : 'Answer in your own words.');
  if (actions.some((a) => a.kind === 'allow-once' || a.kind === 'allow-always' || a.kind === 'deny')) lines.push('Allow once, Allow always or No.');
  return lines;
}

/**
 * One card as one Slack message. The same card renders the same message, so
 * a delivery can tell whether its last post still matches. A standing card
 * names what it asks and links to the glass, where it is answered; an ended
 * card shows how it ended and offers nothing.
 */
export function renderCard(card: GlassCard, glassOrigin: string): SlackMessage {
  const title = clip(card.title.replace(/\s+/g, ' ').trim() || FAMILY_LABEL[card.family], SLACK_BUDGET.title);
  const context = clip(
    [FAMILY_LABEL[card.family], card.grounds && slackEscape(card.grounds), standing(card), !card.terminal && slackTime(card.sourceAt)].filter(Boolean).join(' · '),
    SLACK_BUDGET.context,
  );
  const ask = card.terminal ? [] : offered(card.actions);
  // What the card asks always shows in full; the summary gets the room left over.
  const asked = fitted(ask.join('\n'), SLACK_BUDGET.section);
  const room = SLACK_BUDGET.section - asked.length - (asked && card.summary ? 2 : 0);
  const summary = card.summary && room > EXCERPT.length + 40 ? fitted(slackEscape(card.summary), room) : '';
  const section = [summary, asked].filter(Boolean).join('\n\n');
  const open = `${glassOrigin}/#card/${card.id}`;
  const buttons = [
    { label: card.terminal ? 'Open in glass' : ask.length ? 'Answer in glass' : 'Open in glass', url: open, action: 'open-card' },
    ...card.links.slice(0, SLACK_BUDGET.linkButtons).map((l, i) => ({ label: l.label, url: l.url, action: `open-link-${i}` })),
  ];
  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
    ...(section ? [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text: section } }] : []),
    { type: 'actions', elements: buttons.map((b) => ({ type: 'button' as const, text: { type: 'plain_text' as const, text: clip(b.label, SLACK_BUDGET.buttonLabel), emoji: false as const }, url: b.url, action_id: b.action })) },
  ];
  const fallback = clip(`${FAMILY_LABEL[card.family]}: ${title} · ${card.terminal ? card.terminal.state : card.quiet ? 'in progress' : 'waiting for you'}`, SLACK_BUDGET.fallback);
  return { text: fallback, blocks, unfurl_links: false, unfurl_media: false };
}
