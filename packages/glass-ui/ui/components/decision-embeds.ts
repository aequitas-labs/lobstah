import type { DecisionReference, GlassReport } from '@lobstah/core';
import { useEffect, useState } from 'preact/hooks';
import { backend } from '../backend.js';
import { routeDecision } from '../actions.js';
import { getState, viewOf } from '../store.js';
import { html } from '../html.js';
import { reportCard } from './reports.js';
import { prCard } from './prs.js';

/** The detail visit pushes its own history entry; Back reopens this decision and its draft. */
const leaveDecision = () => {
  history.replaceState({ ...history.state, decisionEmbed: true }, '', location.href);
  routeDecision(null);
};

function ReportEmbed({ reference }: { reference: DecisionReference }) {
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
    ? reportCard(report, leaveDecision)
    : html`<div class="dim" role="status">${pending ? 'Loading report' : 'Report unavailable'} · <code>${reference.key}</code></div>`;
}

/** Referenced cards use their existing renderer and never submit the surrounding decision. */
export function DecisionEmbeds({ references }: { references: readonly DecisionReference[] }) {
  const view = viewOf(getState());
  return html`<section class="decision-embeds cards" aria-label="Reports and PRs">${references.map((reference, i) => {
    if (reference.kind === 'report') return html`<${ReportEmbed} key=${i + reference.key} reference=${reference} />`;
    const pr = view?.prs.find((pr) => pr.key === reference.key);
    return pr
      ? prCard(pr, { onOpen: leaveDecision })
      : html`<div key=${i + reference.key} class="dim" role="status">PR unavailable · <code>${reference.key}</code></div>`;
  })}</section>`;
}
