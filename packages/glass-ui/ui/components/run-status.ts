import type { RunResult, RunState } from '@lobstah/core';
import { html } from '../html.js';
import { ageText } from './age.js';
import { STATE_ICON, RunKindDrawing } from './icons.js';

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

/** A run card's mark on the deck: a terminal before its title, in the row's grey. Its status stays at the row's end. */
export const RunKindIcon = html`<span class="runkind" role="img" aria-label="Run card" title="Run card">${RunKindDrawing}</span>`;

/** The icon, named and titled with its words. */
export function RunStatusIcon({ status, result, startedAt }: { status: RunStatus; result?: RunResult; startedAt?: string }) {
  const label = runStatusLabel(status, result, startedAt);
  return html`<span class=${`runicon run-${status} ${TONE[status]}`} role="img" aria-label=${label} title=${label}>${STATE_ICON[status]}</span>`;
}

/**
 * A dispatch's verb as the same kind of icon, in a small pill: an amber
 * spinner while working (a still dot with less motion), a blue hand when it
 * needs a decision, a red stop sign when blocked, a grey pause, a green
 * check when done, and a red X when it failed. Its accessible name and
 * tooltip say the verb, how long it has been in it, and what it waits on.
 */
export type VerbIconVerb = 'working' | 'needs-decision' | 'blocked' | 'paused' | 'done' | 'failed' | 'queued' | 'limited' | 'unknown';

/** A verb's tone, one meaning everywhere: amber in progress, blue needs a decision, red blocked or failed, grey paused, green done. */
export type VerbTone = 'ok' | 'warn' | 'bad' | 'dim' | 'info';

const VERB_WORD: Record<VerbIconVerb, string> = {
  working: 'Working',
  'needs-decision': 'Needs decision',
  blocked: 'Blocked',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
  queued: 'Queued',
  limited: 'Limited',
  unknown: 'Unknown',
};

/** Amber working, blue needs a decision, red blocked or failed, grey paused (a turn in the heavy line too), green done. */
export const VERB_TONE: Record<VerbIconVerb, VerbTone> = {
  working: 'warn',
  'needs-decision': 'info',
  blocked: 'bad',
  paused: 'dim',
  done: 'ok',
  failed: 'bad',
  queued: 'dim',
  limited: 'bad',
  unknown: 'dim',
};

/** True for every dispatch state with a shared icon, including queued, limited and unknown. */
export const isIconVerb = (verb: string): verb is VerbIconVerb => Object.hasOwn(VERB_WORD, verb);

/** The verb icon's words: "Paused · 12m · waiting on review". */
export function verbIconLabel(verb: VerbIconVerb, at?: string, waitingOn?: string): string {
  const parts = [VERB_WORD[verb]];
  if (at && Number.isFinite(Date.parse(at))) parts.push(ageText(at));
  if (waitingOn) parts.push(`waiting on ${waitingOn}`);
  return parts.join(' · ');
}

/**
 * A dispatch's verb icon in its pill, named and titled with its words. `at`
 * is when it took the verb; `waitingOn` what a paused or questioning
 * worker waits on.
 */
export function VerbIcon({ verb, at, waitingOn }: { verb: VerbIconVerb; at?: string; waitingOn?: string }) {
  const label = verbIconLabel(verb, at, waitingOn);
  return html`<span class=${`runicon verbicon verb-${verb} ${VERB_TONE[verb]}`} role="img" aria-label=${label} title=${label}>${STATE_ICON[verb]}</span>`;
}
