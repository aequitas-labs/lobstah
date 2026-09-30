import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lobstahHome } from './paths.js';
import { postNotice } from './notices.js';

/**
 * Requests from the glass (or the CLI) to the helm: one file per request in
 * `requests/<id>.json`. Writing one runs nothing; it posts a notice of the
 * request's kind, which wakes the helm's `man wait`. The helm acts, then
 * closes the request with its outcome.
 */
export type RequestKind = 'decision-answer' | 'trap-request';
export const REQUEST_KINDS: readonly RequestKind[] = ['decision-answer', 'trap-request'];

export interface LobstahRequest {
  id: string;
  kind: RequestKind;
  at: string;
  from: 'glass' | 'cli';
  payload: Record<string, unknown>;
  closedAt?: string;
  outcome?: string;
}

/** A `trap-request` payload: the repo and harness of the trap the person asks for. */
export interface TrapRequestPayload {
  repo: string;
  harness: 'claude' | 'codex';
}

export const TRAP_HARNESSES = ['claude', 'codex'] as const;

export function requestsDir(): string {
  return path.join(lobstahHome(), 'requests');
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requestPath(id: string): string {
  return path.join(requestsDir(), `${id}.json`);
}

function write(r: LobstahRequest): void {
  fs.mkdirSync(requestsDir(), { recursive: true });
  const file = requestPath(r.id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, file);
}

/** Why a trap-request payload is refused, or undefined when it names a configured repo and a known harness. */
export function trapRequestError(payload: unknown, repoKeys: readonly string[]): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'payload must be an object';
  const { repo, harness, ...rest } = payload as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return `unknown field ${Object.keys(rest)[0]}`;
  if (typeof repo !== 'string' || !repoKeys.includes(repo)) return 'unknown repo';
  if (typeof harness !== 'string' || !(TRAP_HARNESSES as readonly string[]).includes(harness)) return 'unknown harness';
  return undefined;
}

function wakeText(r: LobstahRequest): string {
  if (r.kind === 'trap-request') {
    const p = r.payload as unknown as TrapRequestPayload;
    return (
      `trap requested from the ${r.from}: repo ${p.repo}, harness ${p.harness} (request ${r.id}). ` +
      `Reserve it with \`lobstah trap reserve --request ${r.id}\`, then start its session.`
    );
  }
  return `${r.kind} from the ${r.from} (request ${r.id})`;
}

/** Write a request and wake the helm. Validation is the caller's; this runs nothing. */
export function writeRequest(kind: RequestKind, payload: Record<string, unknown>, from: 'glass' | 'cli' = 'glass'): LobstahRequest {
  const r: LobstahRequest = { id: randomUUID(), kind, at: new Date().toISOString(), from, payload };
  write(r);
  postNotice({
    kind,
    text: wakeText(r),
    refId: r.id,
    repo: typeof payload.repo === 'string' ? payload.repo : undefined,
  });
  return r;
}

export function readRequest(id: string): LobstahRequest | undefined {
  if (!ID_RE.test(id)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(requestPath(id), 'utf8')) as LobstahRequest;
    return parsed.id === id && REQUEST_KINDS.includes(parsed.kind) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Requests oldest first; `open: true` keeps those not yet closed. */
export function listRequests(filter: { kind?: RequestKind; open?: boolean } = {}): LobstahRequest[] {
  let files: string[];
  try {
    files = fs.readdirSync(requestsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => readRequest(f.slice(0, -'.json'.length)))
    .filter((r): r is LobstahRequest => r !== undefined)
    .filter((r) => (filter.kind === undefined || r.kind === filter.kind) && (filter.open === undefined || filter.open === (r.closedAt === undefined)))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Close a request with what became of it. Closing a closed request keeps its first outcome. */
export function closeRequest(id: string, outcome: string): LobstahRequest | undefined {
  const r = readRequest(id);
  if (!r) return undefined;
  if (r.closedAt) return r;
  const next: LobstahRequest = { ...r, closedAt: new Date().toISOString(), outcome };
  write(next);
  return next;
}
