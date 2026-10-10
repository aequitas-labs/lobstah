import type {
  BackendStatus,
  DispatchView,
  WharfDocument,
  WharfFile,
  WharfHumanRequest,
} from '../../../../packages/core/src/backend-model.js';
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
  repoRemote: string;
  lastCheckIn: string;
  current: string | null;
  harness?: string;
  session?: string;
}
export interface Snapshot {
  boats: Boat[];
  workers: Worker[];
  documents: WharfDocument[];
  requests: WharfHumanRequest[];
  helmLive: boolean;
}
export interface Detail extends DispatchView {
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
export function requestState(r: WharfHumanRequest): string {
  return r.state === 'queued'
    ? r.waitingForHelm
      ? 'waiting for helm · expires ' + r.expiresAt
      : 'queued for helm · expires ' + r.expiresAt
    : r.state;
}
