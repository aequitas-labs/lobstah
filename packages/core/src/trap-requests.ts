import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lobstahHome } from './paths.js';
import { postNotice } from './notices.js';

/**
 * A trap the person asked for from the glass (or the CLI): one file per
 * request in `trap-requests/<id>.json`. Writing one runs nothing; it posts a
 * `trap-requested` notice, which wakes the helm. The helm reserves the trap
 * with `lobstah trap reserve --request <id>`, which closes the request.
 */
export interface TrapRequest {
  id: string;
  at: string;
  from: 'glass' | 'cli';
  repo: string;
  harness: 'claude' | 'codex';
  closedAt?: string;
  outcome?: string;
}

export const TRAP_HARNESSES = ['claude', 'codex'] as const;

export function trapRequestsDir(): string {
  return path.join(lobstahHome(), 'trap-requests');
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requestPath(id: string): string {
  return path.join(trapRequestsDir(), `${id}.json`);
}

function write(r: TrapRequest): void {
  fs.mkdirSync(trapRequestsDir(), { recursive: true });
  const file = requestPath(r.id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, file);
}

/** Why a request body is refused, or undefined when it names a configured repo and a known harness and nothing else. */
export function trapRequestError(body: unknown, repoKeys: readonly string[]): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be an object';
  const { repo, harness, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return `unknown field ${Object.keys(rest)[0]}`;
  if (typeof repo !== 'string' || !repoKeys.includes(repo)) return 'unknown repo';
  if (typeof harness !== 'string' || !(TRAP_HARNESSES as readonly string[]).includes(harness)) return 'unknown harness';
  return undefined;
}

/** File a trap request and wake the helm. Validation is the caller's; this runs nothing. */
export function writeTrapRequest(opts: { repo: string; harness: 'claude' | 'codex'; from?: 'glass' | 'cli' }): TrapRequest {
  const r: TrapRequest = { id: randomUUID(), at: new Date().toISOString(), from: opts.from ?? 'glass', repo: opts.repo, harness: opts.harness };
  write(r);
  postNotice({
    kind: 'trap-requested',
    text:
      `trap requested from the ${r.from}: repo ${r.repo}, harness ${r.harness}. ` +
      `Reserve it with \`lobstah trap reserve --request ${r.id}\`, then start its session.`,
    refId: r.id,
    repo: r.repo,
  });
  return r;
}

export function readTrapRequest(id: string): TrapRequest | undefined {
  if (!ID_RE.test(id)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(requestPath(id), 'utf8')) as TrapRequest;
    return parsed.id === id && typeof parsed.repo === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Trap requests oldest first; `open: true` keeps those not yet closed. */
export function listTrapRequests(filter: { open?: boolean } = {}): TrapRequest[] {
  let files: string[];
  try {
    files = fs.readdirSync(trapRequestsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => readTrapRequest(f.slice(0, -'.json'.length)))
    .filter((r): r is TrapRequest => r !== undefined && (filter.open === undefined || filter.open === (r.closedAt === undefined)))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Close a request with what became of it. Closing a closed request keeps its first outcome. */
export function closeTrapRequest(id: string, outcome: string): TrapRequest | undefined {
  const r = readTrapRequest(id);
  if (!r || r.closedAt) return r;
  const next: TrapRequest = { ...r, closedAt: new Date().toISOString(), outcome };
  write(next);
  return next;
}
