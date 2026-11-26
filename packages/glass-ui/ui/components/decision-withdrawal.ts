import type { DecisionWithdrawal } from '@lobstah/core';
import { html } from '../html.js';
import { Age } from './common.js';

/** The withdrawal explanation is shared by the inline card and its read-only question. */
export function WithdrawalNote({ withdrawal }: { withdrawal: DecisionWithdrawal }) {
  return html`<p class="dim" role="status">Withdrawn${withdrawal.at ? html` · <time datetime=${withdrawal.at} title=${withdrawal.at}>${Age(withdrawal.at)} ago</time>` : null} · ${withdrawal.reason}</p>`;
}
