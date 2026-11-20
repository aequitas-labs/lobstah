import type { DecisionReference, GlassReport } from '@lobstah/core';
import { linkedPrKeys, type PrLinkableCard } from '@lobstah/core/dist/pr-linked-cards.js';
import { detailHash } from '../../src/glass-diff.js';
import { useEffect, useState } from 'preact/hooks';
import { backend } from '../backend.js';
import { routeDecision } from '../actions.js';
import { getState, viewOf } from '../store.js';
import { html } from '../html.js';
import { reportCard } from './reports.js';
import { prCard } from './prs.js';
import { opener } from './common.js';

/** The detail visit pushes its own history entry; Back reopens this decision and its draft. */
const leaveDecision = () => {
  history.replaceState({ ...history.state, decisionEmbed: true }, '', location.href);
  routeDecision(null);
};

export function ReportEmbed({ reference, onOpen }: { reference: DecisionReference; onOpen?: () => void }) {
  const cached = viewOf(getState())?.reports.find((report) => report.key === reference.key);
  const [loaded, setLoaded] = useState<GlassReport>();
  const [pending, setPending] = useState(!cached);
  useEffect(() => {
    if (cached) return;
    let live = true;
    setPending(true);
    void backend()
      .report(reference.key)
      .then((result) => {
        if (live && result.ok) setLoaded(result.data);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  }, [reference.key, !!cached]);
  const report = cached ?? loaded;
  return report
    ? reportCard(report, onOpen)
    : html`<div class="dim" role="status">${pending ? 'Loading report' : 'Report unavailable'} · <code>${reference.key}</code></div>`;
}

/** Referenced cards use their existing renderer and never submit the surrounding decision. */
export function DecisionEmbeds({ references }: { references: readonly DecisionReference[] }) {
  const view = viewOf(getState());
  return html`<section class="decision-embeds cards" aria-label="Reports and PRs">${references.map((reference, i) => {
    if (reference.kind === 'report')
      return html`<${ReportEmbed} key=${i + reference.key} reference=${reference} onOpen=${leaveDecision} />`;
    const pr = view?.prs.find((pr) => pr.key === reference.key);
    return pr
      ? prCard(pr, { onOpen: leaveDecision, inCard: true })
      : html`<div key=${i + reference.key} class="dim" role="status">PR unavailable · <code>${reference.key}</code></div>`;
  })}</section>`;
}

/**
 * A tag per PR the card was asked about with `--pr`, beside its title: the
 * PR as `owner/repo#N`, linking to that PR's own card in the glass. In a
 * stack it is the PR named, never the stack.
 */
export function DecisionPrTags({ card }: { card: PrLinkableCard }) {
  return linkedPrKeys(card).map((key) => {
    const open = (e: Event) => {
      e.preventDefault();
      leaveDecision();
      opener('pr', key)();
    };
    const label = key.replace(/^pr:/, '');
    return html`<a key=${key} class="chip click dprtag" href=${detailHash({ type: 'pr', key })} aria-label=${`Open PR ${label}`} onClick=${open}>${label}</a>`;
  });
}
