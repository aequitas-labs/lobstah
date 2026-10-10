import type { DispatchInput, ReportInput } from '../../../packages/core/src/backend-model.js';
import { validateRepoIdentity } from '../../../packages/core/src/repo-identity.js';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function requireThat(ok: unknown, status: number, message: string): asserts ok {
  if (!ok) throw new ApiError(status, message);
}
export function object(value: unknown): Record<string, unknown> {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 400, 'expected object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 1024): string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= max, 400, 'invalid string');
  return value;
}
export function identifier(value: unknown): string {
  const s = text(value, 128); requireThat(/^[A-Za-z0-9_-]+$/.test(s), 400, 'invalid identifier'); return s;
}
export function repoIdentity(value: unknown): string {
  try { return validateRepoIdentity(value); } catch { throw new ApiError(400, 'canonical repoRemote required'); }
}
export function boatName(value: unknown): string {
  const name = text(value, 64).toLowerCase();
  requireThat(/^[a-z0-9][a-z0-9_-]*$/.test(name), 400, 'boat name must use letters, digits, - or _, at most 64 characters');
  return name;
}
function keys(b: Record<string, unknown>, allowed: string[]) {
  requireThat(Object.keys(b).every((k) => allowed.includes(k)), 400, 'unexpected field');
}
export function dispatchInput(value: unknown): DispatchInput {
  const b = object(value);
  keys(b, ['id', 'repo', 'repoRemote', 'brief', 'lane', 'for', 'boat', 'followUp', 'harness', 'model', 'effort']);
  const d: DispatchInput = { id: identifier(b.id), repo: identifier(b.repo), repoRemote: repoIdentity(b.repoRemote), brief: text(b.brief, 48000) };
  if (b.lane !== undefined) { requireThat(b.lane === 'work' || b.lane === 'chore', 400, 'invalid lane'); d.lane = b.lane; }
  for (const k of ['for', 'boat', 'followUp', 'harness', 'effort'] as const) {
    if (b[k] !== undefined) d[k] = identifier(b[k]);
  }
  if (b.model !== undefined) { const model = text(b.model, 128); requireThat(/^[A-Za-z0-9._-]+$/.test(model), 400, 'invalid model identifier'); d.model = model; }
  return d;
}
export function reportInput(value: unknown): ReportInput {
  const b = object(value); keys(b, ['verb', 'note', 'waitingOn', 'until', 'link', 'evidence']);
  requireThat(['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed'].includes(String(b.verb)), 400, 'invalid report verb');
  const r: ReportInput = { verb: b.verb as ReportInput['verb'] };
  if (b.note !== undefined) r.note = text(b.note, 16000);
  if (b.waitingOn !== undefined) {
    requireThat(['paused', 'needs-decision', 'blocked'].includes(r.verb) && ['review', 'pr', 'deploy', 'person', 'external'].includes(String(b.waitingOn)), 400, 'invalid waitingOn');
    r.waitingOn = b.waitingOn as ReportInput['waitingOn'];
  }
  if (b.until !== undefined) {
    requireThat(r.verb === 'paused' && typeof b.until === 'string' && Number.isFinite(Date.parse(b.until)), 400, 'invalid pause deadline');
    r.until = new Date(Date.parse(b.until)).toISOString();
  }
  if (b.link !== undefined) r.link = httpUrl(b.link);
  if (b.evidence !== undefined) {
    const e = object(b.evidence); keys(e, ['prUrls', 'files', 'commits']); r.evidence = {};
    for (const k of ['prUrls', 'files', 'commits'] as const) {
      if (e[k] === undefined) continue;
      requireThat(Array.isArray(e[k]) && e[k].length <= 32, 400, 'too much evidence');
      r.evidence[k] = e[k].map((v: unknown) => k === 'prUrls' ? httpUrl(v) : identifier(v));
    }
  }
  return r;
}
export function httpUrl(value: unknown): string {
  const s = text(value, 2048); let u: URL;
  try { u = new URL(s); } catch { throw new ApiError(400, 'invalid URL'); }
  requireThat(['https:', 'http:'].includes(u.protocol) && !u.username && !u.password, 400, 'invalid URL'); return s;
}
export async function digest(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
export function hex(b: ArrayBuffer): string { return Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join(''); }
export function sameHash(a: string, b: string): boolean {
  const encode = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (v) => parseInt(v, 16));
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && crypto.subtle.timingSafeEqual(encode(a), encode(b));
}
export async function capability(secret: string, context: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(context)));
}
export async function boundedBody(request: Request, max = 65536): Promise<Uint8Array> {
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      n += value.byteLength; requireThat(n <= max, 413, 'body too large'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(n); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; } return bytes;
}
