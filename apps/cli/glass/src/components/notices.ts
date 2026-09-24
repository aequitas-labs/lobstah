import type { Notice } from '@lobstah/core';
import type { SectionInputs } from '../../../src/glass-diff.js';
import { html } from '../html.js';
import { Age, Table } from './common.js';

/** The Notices tab: always a table, whatever the view. */
const row = (n: Notice) =>
  html`<tr key=${n.seq}><td class="dim">${Age(n.at)}</td><td>${n.kind}</td><td class="grow">${n.text}</td><td class="dim">${n.repo ?? ''}</td></tr>`;

export const Notices = ({ inp }: { inp: SectionInputs['notices'] }) =>
  Table(['at', 'kind', 'text', 'repo'], inp.list.map(row), 'no notices');
