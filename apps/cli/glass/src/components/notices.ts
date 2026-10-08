import type { Notice } from '@lobstah/core';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import { Age, ShowOlder, Table } from './common.js';
import type { OlderControl } from './common.js';

/** The Notices tab: always a table, whatever the view. */
const row = (n: Notice) =>
  html`<tr key=${n.seq}><td class="dim">${Age(n.at)}</td><td>${n.kind}</td><td class="grow">${n.url ? html`<a href=${n.url} target="_blank" rel="noopener">${n.text}</a>` : n.text}</td><td class="dim">${n.repo ?? ''}</td></tr>`;

export const Notices = ({ inp, more }: { inp: SectionInputs['notices']; more?: OlderControl }) => [
  Table(['at', 'kind', 'text', 'repo'], inp.list.map(row), 'no notices'),
  more && html`<${ShowOlder} kind="notices" more=${more} />`,
];
