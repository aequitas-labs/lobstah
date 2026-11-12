import type { RunResult, RunState } from '@lobstah/core';
import { html } from '../html.js';

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

/** The icon, named and titled with its words. */
export function RunStatusIcon({ status, result, startedAt }: { status: RunStatus; result?: RunResult; startedAt?: string }) {
  const label = runStatusLabel(status, result, startedAt);
  return html`<span class=${`runicon run-${status} ${TONE[status]}`} role="img" aria-label=${label} title=${label}>${ICON[status]}</span>`;
}
