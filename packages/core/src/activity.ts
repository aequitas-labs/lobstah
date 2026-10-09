import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Lane, NormalizedEvent } from './types.js';
import { uniqueTempPath, activityPath } from './paths.js';

/**
 * Activity: what a worker is doing right now, derived from its event stream
 * (headless) or from a post-tool hook (a trap). It never depends on the
 * model remembering to report. The worker's own report (verb and note) stays
 * the primary line; activity sits under it.
 */
export const ACTIVITY_KINDS = ['tool', 'message', 'thinking', 'waiting'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface Activity {
  at: string;
  kind: ActivityKind;
  /** A short, safe description: tool name and primary target. Never tool input, contents, or secrets. */
  summary: string;
}

export const ACTIVITY_SUMMARY_MAX = 80;

/**
 * Words that look like credentials: known token prefixes, JWTs, bearer
 * values, `key=value` pairs with a secret-sounding key, and long runs of
 * mixed letters and digits.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/i,
  /\b(?:gh[posur]_|github_pat_|glpat-|xox[abprs]-|npm_|hf_)[A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /\bbearer\b/i,
  /(?:token|secret|passw(?:or)?d|pwd|api[-_]?key|auth|credential|private[-_]?key)[^\s]*[=:]/i,
];

function looksSecret(word: string): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(word))) return true;
  // A long run with letters and digits mixed is a key, not a word.
  for (const run of word.match(/[A-Za-z0-9+/_=-]{24,}/g) ?? []) {
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) return true;
  }
  return false;
}

/** Replace every secret-looking word, collapse whitespace, and cap the length. */
export function redactSummary(s: string, max = ACTIVITY_SUMMARY_MAX): string {
  const clean = s
    .replace(/[\r\n\t]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (looksSecret(w) ? '[redacted]' : w))
    .join(' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd']);

/** The first word of a command, as a bare program name. Env assignments and shell wrappers are skipped. */
export function commandWord(command: string): string | undefined {
  let words = command.trim().split(/\s+/).filter(Boolean);
  // `FOO=bar cmd`: the assignment carries a value, never shown.
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
  if (words[0] === 'env') {
    words = words.slice(1);
    while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || words[0]!.startsWith('-'))) words = words.slice(1);
  }
  const first = words[0];
  if (!first) return undefined;
  const name = baseName(first.replace(/^["']|["']$/g, '')).replace(/\.(exe|cmd|bat)$/i, '');
  // `bash -lc 'git status'`: the wrapped command is the one that matters.
  if (SHELLS.has(name.toLowerCase()) && words[1] && /^(-\w*c|\/c|-command)$/i.test(words[1])) {
    return commandWord(words.slice(2).join(' ').replace(/^["']/, '')) ?? name;
  }
  return name || undefined;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? p;
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * A file path relative to the worktree, with forward slashes. A path outside
 * the worktree shows as its last segment only.
 */
export function relativeTarget(p: string, root?: string): string {
  if (!root) return baseName(p);
  const win = isWindowsPath(p) || isWindowsPath(root);
  const lib = win ? path.win32 : path.posix;
  if (!lib.isAbsolute(p)) return p.replace(/\\/g, '/');
  const rel = lib.relative(win ? root : root.replace(/\\/g, '/'), p);
  if (!rel || rel.startsWith('..') || lib.isAbsolute(rel)) return `…/${baseName(p)}`;
  return rel.replace(/\\/g, '/');
}

/** The host of a URL. Credentials, path, and query are dropped. */
export function urlHost(u: string): string | undefined {
  try {
    return new URL(u).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The primary target of a tool call, from its input: a file path, a
 * command's first word, a URL's host, or a named sub-agent or skill. Returns
 * undefined when the input has none of these. Never the full input.
 */
export function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' && (i[k] as string).length > 0 ? (i[k] as string) : undefined);
  const file = str('file_path') ?? str('notebook_path') ?? str('path');
  if (file) return file;
  const command = str('command') ?? (Array.isArray(i.command) ? i.command.map(String).join(' ') : undefined);
  if (command) return commandWord(command);
  const url = str('url');
  if (url) return urlHost(url);
  const changes = i.changes;
  if (Array.isArray(changes) && changes.length > 0) {
    const first = changes[0] as { path?: unknown };
    if (typeof first?.path === 'string') return first.path;
  }
  return str('subagent_type') ?? str('skill');
}

/** A summary for one tool call: its name and primary target, relative to the worktree, redacted. */
export function toolSummary(name: string, target: string | undefined, root?: string): string {
  const looksPath = target !== undefined && (/[\\/]/.test(target) || isWindowsPath(target));
  const shown = target === undefined ? '' : looksPath ? relativeTarget(target, root) : target;
  return redactSummary(shown ? `${name} ${shown}` : name);
}

/** The activity one normalized event implies, or undefined for events that change nothing. */
export function activityFromEvent(ev: NormalizedEvent, root?: string): Omit<Activity, 'at'> | undefined {
  const data = ev.data ?? {};
  switch (ev.type) {
    case 'tool-start': {
      const name = typeof data.name === 'string' && data.name ? data.name : 'tool';
      const target = typeof data.target === 'string' ? data.target : undefined;
      return { kind: 'tool', summary: toolSummary(name, target, root) };
    }
    case 'text':
      return { kind: 'message', summary: 'writing a message' };
    case 'thinking':
      return { kind: 'thinking', summary: 'thinking' };
    case 'runner': {
      if (typeof data.on === 'string') return { kind: 'waiting', summary: redactSummary(`waiting on ${data.on}`) };
      if (typeof data.waiting === 'string') return { kind: 'waiting', summary: redactSummary(`waiting for an answer (${data.waiting})`) };
      if (data.holding === 'background') return { kind: 'waiting', summary: 'waiting on background work' };
      return undefined;
    }
    default:
      return undefined;
  }
}

function atomicWrite(file: string, content: string): void {
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function writeActivity(id: string, lane: Lane, a: Activity): void {
  const safe: Activity = { at: a.at, kind: a.kind, summary: redactSummary(a.summary) };
  atomicWrite(activityPath(id, lane), JSON.stringify(safe));
}

export function readActivity(id: string, lane: Lane): Activity | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(activityPath(id, lane), 'utf8')) as Activity;
    if (typeof parsed.at !== 'string' || typeof parsed.summary !== 'string') return undefined;
    if (!(ACTIVITY_KINDS as readonly string[]).includes(parsed.kind)) return undefined;
    // Treat on-disk activity as untrusted too: old or externally written
    // records may predate writeActivity's redaction.
    return { ...parsed, summary: redactSummary(parsed.summary) };
  } catch {
    return undefined;
  }
}

/** A compact age: 45s, 12m, 3.5h, 2d. */
export function ageLabel(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Activity as a reader sees it: the record, its age, and whether it passed the wedge threshold. */
export interface ActivityView extends Activity {
  ageSecs: number;
  stale: boolean;
}

export function activityView(a: Activity | undefined, staleSecs: number, now = Date.now()): ActivityView | undefined {
  if (!a) return undefined;
  const ageSecs = Math.max(0, Math.round((now - (Date.parse(a.at) || 0)) / 1000));
  return { ...a, ageSecs, stale: ageSecs > staleSecs };
}

/** One line: `Edit src/a.ts (12s ago)`, or `stale: Edit src/a.ts (14m ago)`. */
export function activityLine(v: ActivityView): string {
  return `${v.stale ? 'stale: ' : ''}${v.summary} (${ageLabel(v.ageSecs * 1000)} ago)`;
}

export interface ActivityTrackerOpts {
  /** Minimum interval between writes of the same kind. */
  throttleMs?: number;
  /** Worktree root: file targets show relative to it. */
  root?: string;
  now?: () => number;
}

/**
 * Throttled activity writer: at most one write per window, plus one on
 * every change of kind. A record held back by the window is written when
 * the window closes, so the file never lags the stream by more than one
 * window. Write errors are swallowed: activity is display, never control.
 */
export class ActivityTracker {
  private lastWriteAt = -Infinity;
  private lastKind: ActivityKind | undefined;
  private pending: Activity | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly throttleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly write: (a: Activity) => void,
    private readonly opts: ActivityTrackerOpts = {},
  ) {
    this.throttleMs = opts.throttleMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  observe(ev: NormalizedEvent): void {
    const derived = activityFromEvent(ev, this.opts.root);
    if (derived) this.offer({ at: new Date(this.now()).toISOString(), ...derived });
  }

  offer(a: Activity): void {
    const t = this.now();
    if (a.kind !== this.lastKind || t - this.lastWriteAt >= this.throttleMs) {
      this.emit(a, t);
      return;
    }
    this.pending = a;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, Math.max(0, this.throttleMs - (t - this.lastWriteAt)));
      this.timer.unref?.();
    }
  }

  /** Write a held record now. */
  flush(): void {
    if (!this.pending) return;
    const a = this.pending;
    this.emit(a, this.now());
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private emit(a: Activity, t: number): void {
    this.pending = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.lastWriteAt = t;
    this.lastKind = a.kind;
    try {
      this.write(a);
    } catch {
      // display only
    }
  }
}
