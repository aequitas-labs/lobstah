import type { StatsDay, StatsPage } from '@lobstah/core';
import { focusStatsDay } from '../actions.js';
import { html } from '../html.js';
import { PetArt } from './pet-art.js';

/**
 * The Stats tab: headline numbers, a GitHub-style heatmap of catches per
 * local day over the last 53 weeks (columns are weeks, rows Sunday →
 * Saturday), a Less … More legend, and the top traps. Everything comes from
 * `/data/stats`, which reads the local stats.json; nothing is sent anywhere.
 *
 * The heatmap is one ARIA grid with a single tab stop: arrow keys move a
 * day (↑ ↓) or a week (← →), Home and End jump to the first day and today.
 * Each day says its date and count in its label and in a tooltip on hover
 * or focus.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TOP_TRAPS = 5;

const plural = (n: number, one: string, many = one + 'es') => `${n} ${n === 1 ? one : many}`;

/** A day's tooltip and accessible label: "3 catches on 2026-10-06". */
export const dayLabel = (d: Pick<StatsDay, 'date' | 'count'>): string =>
  d.count ? `${plural(d.count, 'catch')} on ${d.date}` : `No catches on ${d.date}`;

/** Scroll a heatmap to its newest week once, when it first mounts (a narrow window shows today). */
const scrolled = new WeakSet<Element>();
const toNewest = (el: HTMLElement | null) => {
  if (!el || scrolled.has(el)) return;
  scrolled.add(el);
  el.scrollLeft = el.scrollWidth;
};

const KEY_STEP: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };

function Heatmap({ page, focus }: { page: StatsPage; focus: string | null }) {
  const days = page.weeks.flat();
  const current = focus && days.some((d) => d.date === focus) ? focus : page.today;
  const onKey = (e: KeyboardEvent) => {
    const at = days.findIndex((d) => d.date === current);
    let next: number;
    if (e.key in KEY_STEP) next = at + KEY_STEP[e.key]!;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = days.length - 1;
    else return;
    e.preventDefault();
    const day = days[Math.max(0, Math.min(days.length - 1, next))]!;
    focusStatsDay(day.date);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-date="${day.date}"]`)?.focus();
  };
  const lastWeek = page.weeks.length - 1;
  const cell = (week: StatsDay[], w: number, row: number) => {
    const d = week[row];
    if (!d) return html`<td key=${w} class="pad"></td>`;
    const label = dayLabel(d);
    const edge = w < 4 ? ' tl' : w > lastWeek - 4 ? ' tr' : '';
    return html`<td
      key=${w}
      role="gridcell"
      class=${`day l${d.level}${row < 2 ? ' below' : ''}${edge}`}
      data-date=${d.date}
      data-tip=${label}
      aria-label=${label}
      tabindex=${d.date === current ? 0 : -1}
      onFocus=${() => focusStatsDay(d.date)}
    ></td>`;
  };
  const first = page.months[0]?.week ?? page.weeks.length;
  return html`<div class="heat-scroll" ref=${toNewest}>
    <table class="heatmap" role="grid" aria-label=${`Catches per day, last ${page.weeks.length} weeks`} onKeyDown=${onKey}>
      <thead aria-hidden="true">
        <tr>
          <td class="wd"></td>
          ${first > 0 && html`<td colspan=${first}></td>`}
          ${page.months.map(
            (m, i) =>
              html`<td key=${m.week} class="month" colspan=${(page.months[i + 1]?.week ?? page.weeks.length) - m.week}><span>${m.label}</span></td>`,
          )}
        </tr>
      </thead>
      <tbody>
        ${WEEKDAYS.map(
          (name, row) =>
            html`<tr key=${name} role="row">
              <td class="wd" aria-hidden="true">${row % 2 ? name : ''}</td>
              ${page.weeks.map((week, w) => cell(week, w, row))}
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

const Legend = () =>
  html`<div class="heat-legend" aria-hidden="true">
    Less ${[0, 1, 2, 3, 4].map((l) => html`<span key=${l} class=${'swatch l' + l}></span>`)} More
  </div>`;

function Tiles({ page }: { page: StatsPage }) {
  const tiles: Array<[string, number]> = [
    ['today', page.catchesToday],
    ['this week', page.catchesThisWeek],
    ['total', page.totalCatches],
  ];
  return html`<div class="stat-tiles">
    ${tiles.map(([label, n]) => html`<div key=${label} class="stat-tile"><div class="n">${n}</div><div class="dim">${label}</div></div>`)}
  </div>`;
}

function TopTraps({ page }: { page: StatsPage }) {
  const top = page.perTrap.slice(0, TOP_TRAPS);
  if (!top.length) return null;
  const most = top[0]!.catches || 1;
  return html`<section class="top-traps">
    <h2>Top traps <span class="dim">· all time</span></h2>
    <ol>
      ${top.map(
        (t) =>
          html`<li key=${t.name}><span class="name" title=${t.name}>${t.name}</span><span class="bar"><span style=${{ width: `${(t.catches / most) * 100}%` }}></span></span><span class="n">${plural(t.catches, 'catch')}</span></li>`,
      )}
    </ol>
  </section>`;
}

export function Stats({ page, error, focus }: { page: StatsPage | null; error: string | null; focus: string | null }) {
  if (!page) return html`<div class="empty">${error ?? 'loading stats…'}</div>`;
  return html`<div class="stats">
    <${Tiles} page=${page} />
    ${
      page.totalCatches === 0 &&
      html`<div class="stats-empty"><${PetArt} /><div><b>No catches yet.</b> <span class="dim">A dispatch that finishes done is a catch; each one lands on its day here.</span></div></div>`
    }
    <section class="heat">
      <h2>Catches per day</h2>
      <${Heatmap} page=${page} focus=${focus} />
      <div class="heat-foot">
        <span class="dim"
          >${
            page.undated > 0
              ? `${plural(page.undated, 'earlier catch')} ${page.undated === 1 ? 'has' : 'have'} no recorded day${page.historyFrom ? `; daily history starts ${page.historyFrom}` : ''}.`
              : ''
          }</span
        >
        <${Legend} />
      </div>
    </section>
    <${TopTraps} page=${page} />
    ${error && html`<div class="dim">${error}; showing the last numbers read.</div>`}
  </div>`;
}
