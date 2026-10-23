import type { ComponentChildren } from 'preact';
import type { DecisionCard } from '../../../src/glass-diff.js';
import { selectProposalRule, sendPermissionsProposal, setDraft } from '../actions.js';
import { html } from '../html.js';
import type { DecisionDraft } from '../store.js';

type ProposalCard = Extract<DecisionCard, { kind: 'decision' }>;

/** The person reviews an exact diff, optionally unticks rules, then approves or rejects through a dedicated action. */
export function PermissionsProposalCard({ card, draft }: { card: ProposalCard; draft?: DecisionDraft }): ComponentChildren {
  const proposal = card.permissionsProposal!;
  const selected = draft?.proposalSelection ?? proposal.rules.map((rule) => rule.id);
  const busy = !!draft?.sending || !!draft?.proposalLoading;
  const reviewed = draft?.proposalSelection ? !!draft.proposalDiffHash : true;
  return html`<div class="mdpage permissions-proposal">
    <span class="badge warn">permissions proposal</span>
    <p>${proposal.reason}</p>
    <p>Changes go to:</p><ul>${proposal.targets.map((target) => html`<li><code>${target}</code></li>`)}</ul>
    ${draft?.proposalEditing && html`<fieldset><legend>Rules to apply</legend>${proposal.rules.map((rule) => html`<label class="goal-check"><input type="checkbox" checked=${selected.includes(rule.id)} disabled=${busy} onChange=${() => void selectProposalRule(card.key, rule.id)} /><span>${rule.action === 'add' ? 'Add' : 'Remove'} ${rule.harness === 'codex' ? 'Codex' : 'Claude'}: <code>${JSON.stringify(rule.rule)}</code></span></label>`)}</fieldset>`}
    <pre class="proposal-diff">${draft?.proposalDiff ?? proposal.diff}</pre>
    ${draft?.error && html`<div class="bad derr">${draft.error}</div>`}
    <div class="dfoot">
      <button type="button" class="btn proposal-approve" disabled=${busy || !selected.length || !reviewed} onClick=${() => void sendPermissionsProposal(card.key, 'Approve')}>${draft?.sending ? 'Applying…' : 'Approve'}</button>
      <button type="button" class="btn proposal-reject" disabled=${busy} onClick=${() => void sendPermissionsProposal(card.key, 'Reject')}>Reject</button>
      <button type="button" class="btn proposal-edit" disabled=${busy} onClick=${() => setDraft(card.key, { proposalEditing: true })}>Edit</button>
    </div>
  </div>`;
}
