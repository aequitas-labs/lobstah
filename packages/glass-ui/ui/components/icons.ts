import type { GlassTab } from '../../src/glass-diff.js';
import type { Children } from '../html.js';
import { html } from '../html.js';

/**
 * The glass's one menu icon set (Feather, MIT) and its one mapping: every
 * view and menu item shows the same icon on a desktop and a phone, in the tab
 * bar, More, the phone's bottom bar and its menu. Import from here; never
 * draw a menu icon anywhere else. Each sits beside its words, so it carries
 * no name of its own.
 */

const svg = (body: string) =>
  html`<svg class="navicon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{ __html: body }}></svg>`;

/** The dispatch kind: a small fish, drawn once for navigation, cards, chips and notices. */
export const DispatchIcon = html`<svg class="dispatch-icon navicon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12c-3-5-8-7-13-3L3 5v14l5-4c5 4 10 2 13-3Z"/><path d="M15 8c-2 2-2 6 0 8"/><circle cx="17" cy="11" r=".8" fill="currentColor" stroke="none"/></svg>`;

/** Each view's icon. Configuration (the `settings` tab) is lobstah's own settings: sliders, apart from the glass's gear. */
export const TAB_ICON: Record<GlassTab, Children> = {
  deck: svg(
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  ),
  dispatches: DispatchIcon,
  traps: svg(
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  ),
  boats: svg('<circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>'),
  prs: svg(
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>',
  ),
  reviews: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  reports: svg(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  ),
  grants: svg(
    '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  ),
  todos: svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  notices: svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  stats: svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
  settings: svg(
    '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  ),
};

/** The menus' other items: the glass's own Settings (a gear), Search, Menu, Sign out and New trap. */
export const ITEM_ICON = {
  settings: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  ),
  search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  menu: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>'),
  signOut: svg(
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  ),
  newTrap: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
} satisfies Record<string, Children>;

const statusSvg = (body: string) =>
  html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{ __html: body }}></svg>`;

const RUN_STATE_ICON = {
  succeeded: statusSvg('<path d="M3 8.5l3.2 3.2L13 4.8"/>'),
  failed: statusSvg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  'timed-out': statusSvg('<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/>'),
  // A spinning arc; with reduced motion, glass.css shows the still dot instead.
  running: statusSvg(
    '<g class="runspin"><circle cx="8" cy="8" r="6" stroke-opacity="0.3"/><path d="M8 2a6 6 0 0 1 6 6"/></g><circle class="rundot" cx="8" cy="8" r="4" fill="currentColor" stroke="none"/>',
  ),
  stopped: statusSvg('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>'),
  declined: statusSvg('<circle cx="8" cy="8" r="6.2"/><path d="M3.6 12.4l8.8-8.8"/>'),
} satisfies Record<string, Children>;

const REPORT_STATE_ICON = {
  working: RUN_STATE_ICON.running,
  // A raised open hand: three fingers, then the little finger running into the palm and thumb.
  'needs-decision': statusSvg(
    '<g transform="scale(0.6667)" stroke-width="2.4"><path d="M7.5 12.5V6a1.5 1.5 0 0 1 3 0v5"/><path d="M10.5 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M13.5 10.5V5.5a1.5 1.5 0 0 1 3 0v5.5"/><path d="M16.5 11V8.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a6 6 0 0 1-4.6-2.2L3.4 16a1.6 1.6 0 0 1 2.5-2l1.6 1.5v-3"/></g>',
  ),
  // A stop sign: an octagon with a bar.
  blocked: statusSvg('<path d="M5.6 2.2h4.8l3.4 3.4v4.8l-3.4 3.4H5.6l-3.4-3.4V5.6z" stroke-width="1.6"/><path d="M5.2 8h5.6"/>'),
  paused: statusSvg(
    '<rect x="4" y="3.5" width="2.6" height="9" rx="0.8" fill="currentColor" stroke="none"/><rect x="9.4" y="3.5" width="2.6" height="9" rx="0.8" fill="currentColor" stroke="none"/>',
  ),
  done: RUN_STATE_ICON.succeeded,
  failed: RUN_STATE_ICON.failed,
} satisfies Record<string, Children>;

/** A run card's terminal mark, separate from its result. */
export const RunKindDrawing = statusSvg(
  '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" stroke-width="1.5"/><path d="M4.6 6.3l2 1.7-2 1.7M8.4 10h3" stroke-width="1.5"/>',
);

/** State drawings shared by every glass host, card, table and menu. */
export const STATE_ICON = {
  ...REPORT_STATE_ICON,
  queued: svg('<path d="M3 5h18v14H3z"/><path d="M3 13h5l2 3h4l2-3h5"/>'),
  limited: svg('<path d="M6 3h12M6 21h12M7 3v4l5 5-5 5v4M17 3v4l-5 5 5 5v4"/>'),
  unknown: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2l-1.5 1v2M12 17h.01"/>'),
  active: svg('<path d="M2 12h5l3-8 4 16 3-8h5"/>'),
  requested: svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>'),
  starting: svg('<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>'),
  listening: svg(
    '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4-8.4a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2m14.2-14.2a10 10 0 0 1 0 14.2"/>',
  ),
  'not-listening': svg('<path d="m3 3 18 18M5 6a10 10 0 0 0 0 13M19 5a10 10 0 0 1 2 10M8 9a6 6 0 0 0 0 7M16 8a6 6 0 0 1 2 4"/>'),
  stowed: svg('<path d="M4 8h16v13H4zM3 3h18v5H3zM9 12h6"/>'),
  ghosted: svg('<path d="M5 21V9a7 7 0 0 1 14 0v12l-3-2-4 2-4-2z"/><path d="M9 9h.01M15 9h.01"/>'),
  setup: svg('<path d="M14 6a5 5 0 0 0-6 6L2 18l4 4 6-6a5 5 0 0 0 6-6l-4 4-4-4z"/>'),
  stalled: svg('<path d="m12 3 10 18H2zM12 9v4M12 17h.01"/>'),
  drafted: svg('<path d="M14 2H5v20h14V7zM14 2v6h5M8 15l3 3 5-6"/>'),
  withdrawn: svg('<path d="m8 4-6 6 6 6M2 10h12a6 6 0 0 1 6 6v4"/>'),
  'changes-requested': svg('<path d="M8 2h8l6 6v8l-6 6H8l-6-6V8zM12 7v6M12 17h.01"/>'),
  muted: svg('<path d="m3 3 18 18M6 6a6 6 0 0 0 0 2c0 7-3 7-3 9h14M9 3a6 6 0 0 1 9 5v4M10 21h4"/>'),
  draft: svg('<path d="m16 3 5 5L8 21H3v-5zM13 6l5 5"/>'),
  merged: svg(
    '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 6v12M6 6c0 4 4 6 10 6"/>',
  ),
  conflicts: svg('<path d="M3 3h4l10 18h4M3 21h4L17 3h4"/>'),
  behind: svg('<path d="m10 4-8 8 8 8M2 12h20"/>'),
  unread: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>'),
  read: svg('<path d="m3 9 9-7 9 7v12H3zM3 9l9 7 9-7"/>'),
  standing: svg('<path d="M5 22V3c5-4 9 4 15 0v12c-6 4-10-4-15 0"/>'),
  seen: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>'),
  authorized: svg('<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6zM8 12l3 3 5-6"/>'),
  asleep: svg('<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10"/>'),
  running: RUN_STATE_ICON.running,
  succeeded: RUN_STATE_ICON.succeeded,
  'timed-out': RUN_STATE_ICON['timed-out'],
  stopped: RUN_STATE_ICON.stopped,
  declined: RUN_STATE_ICON.declined,
  waiting: RUN_STATE_ICON['timed-out'],
  configured: TAB_ICON.settings,
  open: TAB_ICON.prs,
  posted: svg('<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>'),
  comment: TAB_ICON.reviews,
} satisfies Record<string, Children>;

export type StateIconName = keyof typeof STATE_ICON;

/** Resolve status labels, including counts and PR check summaries, to their shared drawing. */
export function stateIconName(state: string): StateIconName {
  const name = state.toLowerCase().replace(/[_-]/g, ' ').trim();
  const aliases: Record<string, StateIconName> = {
    'needs decision': 'needs-decision',
    'needs you': 'needs-decision',
    busy: 'working',
    drafting: 'working',
    'in progress': 'working',
    idle: 'listening',
    online: 'listening',
    live: 'listening',
    'signed on': 'listening',
    'not listening': 'not-listening',
    'signed off': 'stowed',
    'start failed': 'failed',
    'needs app start': 'starting',
    'missing config': 'setup',
    'needs setup': 'setup',
    repairing: 'setup',
    parked: 'waiting',
    pending: 'waiting',
    unreported: 'waiting',
    stale: 'waiting',
    expired: 'waiting',
    'awaiting boat': 'waiting',
    'waiting for helm': 'waiting',
    'draft ready': 'drafted',
    'changes requested': 'changes-requested',
    'request changes': 'changes-requested',
    approved: 'done',
    approve: 'done',
    commented: 'comment',
    dismissed: 'declined',
    cancelled: 'declined',
    closed: 'declined',
    revoked: 'declined',
    answered: 'done',
    sent: 'done',
    resolved: 'done',
    landed: 'done',
    fulfilled: 'done',
    applied: 'done',
    received: 'unread',
    refused: 'blocked',
    'timed out': 'timed-out',
    merging: 'merged',
    'merges when green': 'merged',
    green: 'done',
    'ready to merge': 'done',
    review: 'comment',
    'review required': 'comment',
  };
  if (Object.hasOwn(aliases, name)) return aliases[name]!;
  if (/limited/.test(name)) return 'limited';
  if (/repairing/.test(name)) return 'setup';
  if (/repair waits/.test(name)) return 'waiting';
  if (/unknown/.test(name)) return 'unknown';
  if (/failed|failing/.test(name)) return 'failed';
  if (/unresolved/.test(name)) return 'comment';
  if (/^checks|of .* green/.test(name)) return 'waiting';
  const key = name.replace(/ /g, '-') as StateIconName;
  return Object.hasOwn(STATE_ICON, key) ? key : 'unknown';
}

/** A decorative state mark beside words; icon-only callers supply their accessible name on the enclosing element. */
export function StateIcon({ state, size = 16 }: { state: string; size?: number }): Children {
  return html`<span class="state-icon" data-state-icon=${stateIconName(state)} style=${`width:${size}px;height:${size}px`}>${STATE_ICON[stateIconName(state)]}</span>`;
}
