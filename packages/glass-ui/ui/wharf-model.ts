/**
 * The wharf's browser API, as the glass reads it: /api/glass (boats, workers,
 * documents, human requests) and a job's detail. Both glass hosts use these
 * types; the hosted glass's own pages and the wharf backend read them.
 */
import type { BackendStatus, DispatchView, WharfDocument, WharfFile, WharfHumanRequest } from '../../core/src/backend-model.js';
export type { DispatchView, WharfDocument, WharfFile, WharfHumanRequest };
export interface Boat {
  id: string;
  name: string;
  revoked: number;
  permissions: string[];
  repos: string[];
  lastCheckIn: string | null;
}
export interface Worker {
  id: string;
  boat: string;
  boatName: string;
  repoRemote?: string;
  target?: import('../../core/src/configured-trap-model.js').ConfiguredTrapTarget;
  lastCheckIn: string;
  current: string | null;
  /** The boat's lease on this worker is current: its session is still running. */
  live: boolean;
  harness?: string;
  session?: string;
  /** The worker's pane on the boat's lobstah tmux server, when it runs in one. */
  tmuxPane?: string;
}
/** What the hosted glass's GET /api/glass answers: the signed-in person's account. */
export interface WharfGlass {
  boats: Boat[];
  workers: Worker[];
  documents: WharfDocument[];
  requests: WharfHumanRequest[];
  helmLive: boolean;
}
/** What GET /api/glass/dispatches/<id>/detail answers. */
export interface WharfDetail extends DispatchView {
  reports: BackendStatus[];
  messages: { id: string; text: string; received: boolean }[];
  files: WharfFile[];
}
/** Only validated session identifiers produce a command. Unknown is not a guess. */
export function resume(worker: Worker): string | undefined {
  if (!worker.session || !/^[A-Za-z0-9_-]{1,128}$/.test(worker.session)) return;
  if (worker.harness === 'claude') return `claude --resume ${worker.session}`;
  if (worker.harness === 'codex') return `codex resume ${worker.session}`;
}
/** The read-only command that joins a live worker's pane from anywhere. It ignores size, so a small window can't reflow the panes beside it. */
export function attachCommand(worker: Worker): string | undefined {
  if (!worker.tmuxPane || !/^%(0|[1-9][0-9]*)$/.test(worker.tmuxPane)) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(worker.boatName)) return;
  return `ssh ${worker.boatName} -t tmux -L lobstah attach -r -t ${worker.tmuxPane}`;
}
export function requestState(r: WharfHumanRequest): string {
  if (r.kind === 'work' && r.response && (r.state === 'queued' || r.state === 'received')) return 'The helm replied: ' + r.response;
  if (r.kind.startsWith('review-'))
    return r.state === 'authorized'
      ? 'sent to the boat that drafted it · expires ' + r.expiresAt
      : r.state + (r.outcome ? ' · ' + r.outcome : '');
  return r.state === 'queued'
    ? r.waitingForHelm
      ? 'waiting for helm · expires ' + r.expiresAt
      : 'queued for helm · expires ' + r.expiresAt
    : r.state;
}
