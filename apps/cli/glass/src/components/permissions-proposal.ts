import type { ComponentChildren } from 'preact';
import type { PermissionRuleChange } from '@lobstah/core';
import type { DecisionCard } from '../../../src/glass-diff.js';
import { selectProposalRule, sendPermissionsProposal, setDraft } from '../actions.js';
import { html } from '../html.js';
import type { DecisionDraft } from '../store.js';

type ProposalCard = Extract<DecisionCard, { kind: 'decision' }>;

/** One changing rule: its sign, its harness, and the rule itself. */
const change = (rule: PermissionRuleChange) => [
  html`<span class="psign" aria-label=${rule.action === 'add' ? 'add' : 'remove'}>${rule.action === 'add' ? '+' : '−'}</span>`,
  html`<span class="badge">${rule.harness === 'codex' ? 'Codex' : 'Claude'}</span>`,
  html`<code>${rule.harness === 'codex' ? rule.rule.join(' ') : rule.rule}</code>`,
];

/** The person reads only the changing rules, may untick some, then approves or rejects through a dedicated action. */
export function PermissionsProposalCard({ card, draft }: { card: ProposalCard; draft?: DecisionDraft }): ComponentChildren {
  const proposal = card.permissionsProposal!;
  const selected = draft?.proposalSelection ?? proposal.rules.map((rule) => rule.id);
  const busy = !!draft?.sending || !!draft?.proposalLoading;
  const reviewed = draft?.proposalSelection ? !!draft.proposalDiffHash : true;
  const editing = !!draft?.proposalEditing;
  return html`<div class="permissions-proposal">
    <div class="mdpage">
      <p>${proposal.reason}</p>
      <h4>Changes</h4>
      <ul class="proposal-changes">${proposal.rules.map(
        (rule) =>
          html`<li key=${rule.id} class=${'proposal-change ' + rule.action}>${
            editing
              ? html`<label><input type="checkbox" checked=${selected.includes(rule.id)} disabled=${busy} onChange=${() => void selectProposalRule(card.key, rule.id)} />${change(rule)}</label>`
              : change(rule)
          }</li>`,
      )}</ul>
      <details class="proposal-details">
        <summary>Details</summary>
        <p>Files:</p><ul>${proposal.targets.map((target) => html`<li><code>${target}</code></li>`)}</ul>
        <pre class="mdcode proposal-diff">${draft?.proposalDiff ?? proposal.diff}</pre>
      </details>
    </div>
    <div class="doptions">
      <button type="button" class="btn dopt proposal-approve" disabled=${busy || !selected.length || !reviewed} onClick=${() => void sendPermissionsProposal(card.key, 'Approve')}><span class="dlabel">${draft?.sending ? 'Applying…' : 'Approve'}</span></button>
      <button type="button" class="btn dopt proposal-reject" disabled=${busy} onClick=${() => void sendPermissionsProposal(card.key, 'Reject')}><span class="dlabel">Reject</span></button>
      <button type="button" class="btn dopt proposal-edit" aria-pressed=${editing ? 'true' : 'false'} disabled=${busy} onClick=${() => setDraft(card.key, { proposalEditing: true })}><span class="dlabel">Edit</span></button>
    </div>
    ${draft?.error && html`<div class="bad derr">${draft.error}</div>`}
  </div>`;
}
