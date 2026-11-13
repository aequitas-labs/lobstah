import type { GlassSnapshot } from '@lobstah/core';
import { html, type Children } from '../html.js';
import { HarnessIcon } from './harness-icon.js';

/** Repo capacity and available workers from the existing fleet snapshot, with an accessible harness mix. */
export function TrapOverview({ repos }: { repos?: GlassSnapshot['repoTraps'] }): Children {
  return repos?.length
    ? html`<div class="trap-overview" aria-label="Fleet overview">${repos.map((repo) => html`<div key=${repo.repo} class="trap-overview-row"><b>${repo.repo}</b><span>${repo.used}${repo.limit === undefined ? '' : '/' + repo.limit} in use · ${repo.free} free</span>${repo.harnesses.map(({ harness, count }) => html`<span class="trap-harness-count"><${HarnessIcon} harness=${harness} /> ${count}</span>`)}</div>`)}</div>`
    : null;
}
