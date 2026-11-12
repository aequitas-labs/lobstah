import type { RunResult, RunState } from '@lobstah/core';
import { html } from '../html.js';
import { ageText } from './age.js';

/**
 * A run card's state as an icon instead of words: a green check once it
 * succeeded, a red X once it failed, a red clock once it timed out, a
 * yellow spinning circle while it runs (a still dot when the person asks
 * for less motion), a grey square once stopped, and a grey slashed circle
 * once declined. The words, with the exit code and how long it took, are
 * the icon's accessible name and its tooltip, so nothing is lost.
 */

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'timed-out' | 'stopped' | 'declined';

/** core run-cards.ts RUN_DECLINE_OPTION: the run card's one option, which answers it without running. */
export const RUN_DECLINE = 'Decline';

const WORD: Record<RunStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  'timed-out': 'Timed out',
  stopped: 'Stopped',
  declined: 'Declined',
};

/** Green done, red failed or timed out, amber running, grey stopped or declined. */
const TONE: Record<RunStatus, string> = {
  running: 'warn',
  succeeded: 'ok',
  failed: 'bad',
  'timed-out': 'bad',
  stopped: 'dim',
  declined: 'dim',
};

/** A run's status from what the glass knows of it: a run on its way, its result, else the state its record keeps. */
export function runStatus(state: RunState | undefined, result: RunResult | undefined, busy = false): RunStatus | undefined {
  if (busy || state === 'running') return 'running';
  if (result) {
    if (result.timedOut) return 'timed-out';
    if (result.stopped) return 'stopped';
    return result.exitCode === 0 ? 'succeeded' : 'failed';
  }
  return state;
}

/** How long a run took: 850ms, 4.2s, 42s, 3m 12s, 1h 4m. */
export function runDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  if (secs < 60) return `${Math.round(secs)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${Math.round(secs % 60)}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** The icon's words: the status, then the exit code and how long it took, or when it started while it runs. */
export function runStatusLabel(status: RunStatus, result?: RunResult, startedAt?: string): string {
  const parts = [WORD[status]];
  if (result && status !== 'stopped') parts.push(`exit ${result.timedOut ? 124 : result.exitCode}`);
  if (result && result.durationMs > 0) parts.push(runDuration(result.durationMs));
  if (status === 'running' && startedAt) parts.push(`started ${new Date(startedAt).toLocaleTimeString()}`);
  return parts.join(' · ');
}

const svg = (body: string) =>
  html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{ __html: body }}></svg>`;

const ICON: Record<RunStatus, unknown> = {
  succeeded: svg('<path d="M3 8.5l3.2 3.2L13 4.8"/>'),
  failed: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  'timed-out': svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.6"/>'),
  // A spinning arc; with reduced motion, glass.css shows the still dot instead.
  running: svg(
    '<g class="runspin"><circle cx="8" cy="8" r="6" stroke-opacity="0.3"/><path d="M8 2a6 6 0 0 1 6 6"/></g><circle class="rundot" cx="8" cy="8" r="4" fill="currentColor" stroke="none"/>',
  ),
  stopped: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>'),
  declined: svg('<circle cx="8" cy="8" r="6.2"/><path d="M3.6 12.4l8.8-8.8"/>'),
};

/** A run card's mark on the deck: a terminal before its title, in the row's grey. Its status stays at the row's end. */
export const RunKindIcon = html`<span class="runkind" role="img" aria-label="Run card" title="Run card">${svg(
  '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" stroke-width="1.5"/><path d="M4.6 6.3l2 1.7-2 1.7M8.4 10h3" stroke-width="1.5"/>',
)}</span>`;

/** The icon, named and titled with its words. */
export function RunStatusIcon({ status, result, startedAt }: { status: RunStatus; result?: RunResult; startedAt?: string }) {
  const label = runStatusLabel(status, result, startedAt);
  return html`<span class=${`runicon run-${status} ${TONE[status]}`} role="img" aria-label=${label} title=${label}>${ICON[status]}</span>`;
}

/**
 * A dispatch's verb as the same kind of icon, in a small pill: an amber
 * spinner while working (a still dot with less motion), a blue hand when it
 * needs a decision, a red stop sign when blocked, a grey pause, a green
 * check when done, and a red X when it failed. Its accessible name and
 * tooltip say the verb, how long it has been in it, and what it waits on.
 */
export type VerbIconVerb = 'working' | 'needs-decision' | 'blocked' | 'paused' | 'done' | 'failed';

/** A verb's tone, one meaning everywhere: amber in progress, blue needs a decision, red blocked or failed, grey paused, green done. */
export type VerbTone = 'ok' | 'warn' | 'bad' | 'dim' | 'info';

const VERB_WORD: Record<VerbIconVerb, string> = {
  working: 'Working',
  'needs-decision': 'Needs decision',
  blocked: 'Blocked',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
};

/** Amber working, blue needs a decision, red blocked or failed, grey paused (a turn in the heavy line too), green done. */
export const VERB_TONE: Record<VerbIconVerb, VerbTone> = {
  working: 'warn',
  'needs-decision': 'info',
  blocked: 'bad',
  paused: 'dim',
  done: 'ok',
  failed: 'bad',
};

/** True for the six report verbs; a queued or unknown dispatch keeps its word. */
export const isIconVerb = (verb: string): verb is VerbIconVerb => Object.hasOwn(VERB_WORD, verb);

/** The verb icon's words: "Paused · 12m · waiting on review". */
export function verbIconLabel(verb: VerbIconVerb, at?: string, waitingOn?: string): string {
  const parts = [VERB_WORD[verb]];
  if (at && Number.isFinite(Date.parse(at))) parts.push(ageText(at));
  if (waitingOn) parts.push(`waiting on ${waitingOn}`);
  return parts.join(' · ');
}

const VERB_ICON: Record<VerbIconVerb, unknown> = {
  working: ICON.running,
  // A raised open hand: three fingers, then the little finger running into the palm and thumb.
  'needs-decision': svg(
    '<g transform="scale(0.6667)" stroke-width="2.4"><path d="M7.5 12.5V6a1.5 1.5 0 0 1 3 0v5"/><path d="M10.5 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M13.5 10.5V5.5a1.5 1.5 0 0 1 3 0v5.5"/><path d="M16.5 11V8.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a6 6 0 0 1-4.6-2.2L3.4 16a1.6 1.6 0 0 1 2.5-2l1.6 1.5v-3"/></g>',
  ),
  // A stop sign: an octagon with a bar.
  blocked: svg('<path d="M5.6 2.2h4.8l3.4 3.4v4.8l-3.4 3.4H5.6l-3.4-3.4V5.6z" stroke-width="1.6"/><path d="M5.2 8h5.6"/>'),
  paused: svg(
    '<rect x="4" y="3.5" width="2.6" height="9" rx="0.8" fill="currentColor" stroke="none"/><rect x="9.4" y="3.5" width="2.6" height="9" rx="0.8" fill="currentColor" stroke="none"/>',
  ),
  done: ICON.succeeded,
  failed: ICON.failed,
};

/**
 * A dispatch's verb icon in its pill, named and titled with its words. `at`
 * is when it took the verb; `waitingOn` what a paused or questioning
 * worker waits on.
 */
export function VerbIcon({ verb, at, waitingOn }: { verb: VerbIconVerb; at?: string; waitingOn?: string }) {
  const label = verbIconLabel(verb, at, waitingOn);
  return html`<span class=${`runicon verbicon verb-${verb} ${VERB_TONE[verb]}`} role="img" aria-label=${label} title=${label}>${VERB_ICON[verb]}</span>`;
}
