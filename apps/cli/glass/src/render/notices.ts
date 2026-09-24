import type { Notice } from '@lobstah/core';
import { html } from '../html.js';
import type { Html } from '../html.js';
import { ageEl, table } from './common.js';

/** The Notices tab: always a table, whatever the view. */
export function noticeTable(list: Notice[]): Html {
  const row = (n: Notice) =>
    html`<tr><td class="dim">${ageEl(n.at)}</td><td>${n.kind}</td><td class="grow">${n.text}</td><td class="dim">${n.repo ?? ''}</td></tr>`;
  return table(['at', 'kind', 'text', 'repo'], list.map(row), 'no notices');
}
