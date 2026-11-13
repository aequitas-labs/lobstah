import { olderLeft, sectionInputs } from '../../src/glass-diff.js';
import { visibleTabs } from '../backend.js';
import type { GlassOlderKind } from '@lobstah/core';
import type { GlassTab } from '../../src/glass-diff.js';
import { closeModal, modalOrder, unreadOrder } from '../actions.js';
import { html } from '../html.js';
import type { Children } from '../html.js';
import { viewOf } from '../store.js';
import type { GlassState } from '../store.js';
import type { OlderControl } from './common.js';
import { Deck } from './deck.js';
import { DeckDecisions, DecisionAlert, DecisionModal } from './decisions.js';
import { Dispatches } from './dispatches.js';
import { Footer, Header } from './header.js';
import { Lobs } from './lobs.js';
import { LightboxView } from './lightbox.js';
import { ReportSheet } from './report-view.js';
import { Modal, SettingsBody, HelmBody } from './modals.js';
import { Notices } from './notices.js';
import { PRs } from './prs.js';
import { Reports } from './reports.js';
import { Reviews } from './reviews.js';
import { Stats } from './stats.js';
import { activeSessionGrants, SessionGrants } from './session-grants.js';
import { Settings } from './settings.js';
import { Dialog } from './dialog.js';
import { ITEM_ICON } from './icons.js';
import { Traps } from './traps.js';
import { Todos } from './todos.js';
import { SectionHead } from './section-head.js';
import { NewTrap } from './common.js';
import { ToastHost } from './toast.js';
import { host } from '../host.js';

/**
 * The whole page as a pure function of the store. Only the active tab's
 * section renders; the others are empty until opened. Rows, cards, and
 * lobs are keyed, so a new snapshot changes only the DOM whose data changed.
 */
export function App({ state }: { state: GlassState }) {
  const d = viewOf(state);
  const tab = state.route === 'decisions' ? 'deck' : state.route;
  const unread = d ? unreadOrder() : [];
  const inp = d && sectionInputs(d, { st: state.prefs, modal: state.modal, detail: state.detail }, Date.now());
  const more = (kind: GlassOlderKind): OlderControl => ({
    left: state.snapshot ? olderLeft(state.snapshot, state.older, kind) : 0,
    loading: state.olderLoading === kind,
    error: state.olderError?.kind === kind ? state.olderError.text : undefined,
  });
  const page = (t: GlassTab): Children => {
    if (!inp || t !== tab) return null;
    if (t === 'deck' && state.route === 'decisions')
      return html`<${DeckDecisions} page cards=${inp.deck.decisions} drafts=${state.drafts} focus=${state.focusDecision} viewedHere=${state.viewedHere} unread=${unread.length} recentRuns=${inp.deck.recentRuns} />`;
    if (t === 'deck')
      return [
        html`<${Deck} inp=${inp.deck} goals=${d?.goals} passes=${d?.helmPasses} grants=${d?.sessionGrants ?? []} drafts=${state.drafts} focus=${state.focusDecision} viewedHere=${state.viewedHere} unread=${unread.length} />`,
        host().deck?.(),
      ];
    if (t === 'boats') return host().boats?.() ?? null;
    if (t === 'dispatches')
      return [
        html`<${SectionHead} title="Dispatches" count=${inp.dispatches.list.length} page />`,
        html`<${Dispatches} inp=${inp.dispatches} more=${more('dispatches')} />`,
      ];
    if (t === 'traps')
      return [
        html`<${SectionHead} title="Traps" count=${inp.traps.list.length} action=${html`<${NewTrap} />`} page />`,
        html`<${Traps} inp=${inp.traps} grants=${d?.sessionGrants ?? []} />`,
      ];
    if (t === 'prs')
      return [html`<${SectionHead} title="PRs" count=${inp.prs.prs.length} page />`, html`<${PRs} inp=${inp.prs} more=${more('prs')} />`];
    if (t === 'reports')
      return [html`<${SectionHead} title="Reports" count=${inp.reports.list.length} page />`, html`<${Reports} inp=${inp.reports} />`];
    if (t === 'reviews')
      return [
        html`<${SectionHead} title="Reviews" count=${inp.reviews.list.length} page />`,
        html`<${Reviews} inp=${inp.reviews} setup=${d?.reviewSetup} repo=${state.prefs.repo} />`,
      ];
    if (t === 'todos')
      return [
        html`<${SectionHead} title="Todos" count=${inp.deck.todos.filter((todo) => !todo.done).length} page />`,
        html`<${Todos} passes=${d?.helmPasses} todos=${inp.deck.todos} note=${inp.deck.todoNote} />`,
      ];
    if (t === 'grants') {
      const grants = d?.sessionGrants ?? [];
      const standing = d?.standingGrants ?? [];
      return [
        html`<${SectionHead} title="Grants" count=${activeSessionGrants(grants).length + standing.length} page />`,
        html`<${SessionGrants} grants=${grants} standing=${standing} />`,
      ];
    }
    if (t === 'settings')
      return html`<${Settings} page=${state.settings} error=${state.settingsError} passkeys=${state.snapshot?.runPasskeys} passkey=${state.runPasskey} helms=${d?.helms ?? []} reviewSetup=${state.snapshot?.reviewSetup} />`;
    if (t === 'notices')
      return [
        html`<${SectionHead} title="Notices" count=${inp.notices.list.length} page />`,
        html`<${Notices} inp=${inp.notices} more=${more('notices')} />`,
      ];
    if (t === 'stats')
      return [
        html`<${SectionHead} title="Stats" page />`,
        html`<${Stats} page=${state.stats} error=${state.statsError} focus=${state.statsFocus} />`,
      ];
    return null;
  };
  // The glass's own settings open in a Dialog (a sheet on a phone), not the overlay's modal.
  const settingsOpen = state.modal?.type === 'settings';
  const helm = state.modal?.type === 'helm' ? d?.helms.find((helm) => helm.grounds === state.modal!.key) : undefined;
  const onOverlay = (e: Event) => {
    if (e.target === e.currentTarget) closeModal();
  };
  // Each modal owns its controls: retain them on polls, reset them when switching cards.
  return [
    html`<${Header} d=${d} inp=${inp} tab=${tab} st=${state.prefs} stale=${state.stale} unread=${unread.length} />`,
    host().banner?.(),
    visibleTabs().map(
      (t) =>
        html`<main key=${t} id=${'page-' + t} class=${d ? (t === tab ? 'tabpage on' : 'tabpage') : 'tabpage'}><div id=${t}>${page(t)}</div></main>`,
    ),
    html`<footer id="foot"><${Footer} d=${d} /></footer>`,
    html`<div id="lobs"><${Lobs} state=${state} /></div>`,
    d && html`<${ReportSheet} reportKey=${state.reportSheet ?? null} />`,
    html`<${LightboxView} box=${state.lightbox} />`,
    settingsOpen &&
      html`<${Dialog} title="Settings" icon=${ITEM_ICON.settings} cls="settings-dialog" onClose=${closeModal}><${SettingsBody} prefs=${state.prefs} /><//>`,
    html`<div id="overlay" class=${state.modal && d && !settingsOpen ? 'open' + (helm ? ' dialog-overlay' : '') : d ? '' : undefined} onClick=${onOverlay}>${helm ? html`<${Dialog} id="modalbox" title=${helm.man} icon="⛵ " cls="helm-dialog" onClose=${closeModal}><${HelmBody} helm=${helm} /><//>` : html`<div class=${'modal' + (state.modal?.type === 'pr' || state.modal?.type === 'review' ? ' view-modal' : '')} id="modalbox"><${Modal} key=${state.modal ? state.modal.type + ':' + state.modal.key : 'closed'} snapshot=${d} modal=${state.modal} prefs=${state.prefs} detail=${state.detail} /></div>`}</div>`,
    d &&
      html`<${DecisionModal} open=${state.decisionModal} order=${modalOrder()} drafts=${state.drafts} extensions=${d.answerLimits?.extensions ?? []} />`,
    d && html`<${DecisionAlert} unread=${unread} dismissed=${state.alertDismissed} />`,
    html`<${ToastHost} />`,
  ];
}
