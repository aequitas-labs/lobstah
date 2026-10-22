import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { withDirLock } from './dir-lock.js';
import type { WaitConfig } from './config.js';

const fileFor = (key: string) => path.join(lobstahHome(), 'wait-backoff', `${key}.json`);
const sessionKey = (session: string) => `history-${encodeURIComponent(session)}`;
const resetKey = (session: string) => `reset-${encodeURIComponent(session)}`;
function read<T>(key: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(fileFor(key), 'utf8')) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return undefined; throw e; }
}
function write(key: string, value: unknown): void {
  const file = fileFor(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(value));
  atomicRenameSync(tmp, file);
}

/**
 * Whether a prompt hook's prompt is only harness-injected notification: one
 * or more `<task-notification>` envelopes (a finished background task or
 * subagent), optionally inside `<system-reminder>` text, and nothing else.
 * Claude Code runs UserPromptSubmit for these turns too, with no field that
 * says so, and a backgrounded `man wait` or `soak --wait` ending quietly
 * arrives as one. Anything a person typed, or any other text, is not.
 */
export function injectedPrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string' || !/<task-notification>[\s\S]*?<\/task-notification>/.test(prompt)) return false;
  const rest = prompt
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\b[^>]*>/g, '');
  return rest.trim() === '';
}

/** Explicit activity reset. Delivery resets its own session; routine storage writes do not. */
export function resetWaitBackoff(session?: string): void {
  write(session ? resetKey(session) : 'activity', randomUUID());
}
function generation(session?: string): string {
  return JSON.stringify([read<string>('activity'), session ? read<string>(resetKey(session)) : undefined]);
}

/** Empty counts 0, 1, 2 use the base; count 3 doubles it with the defaults. */
export function waitTimeoutSecs(emptyTimeouts: number, config: WaitConfig): number {
  const exponent = Math.max(0, emptyTimeouts - config.baseRepeats + 1);
  return Math.min(config.maxTimeoutSecs, config.baseTimeoutSecs * 2 ** Math.min(exponent, 52));
}

type History = { generation: string; emptyTimeouts: number; wakeKeys?: string[] };
const validCount = (h: History | undefined) => h && Number.isSafeInteger(h.emptyTimeouts) && h.emptyTimeouts >= 0 ? h.emptyTimeouts : 0;
function withHistory<T>(session: string, action: () => T): T {
  const lock = fileFor(sessionKey(session)) + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  return withDirLock(lock, action, { staleMs: 30_000, waitMs: 2000, busy: () => new Error('wait history is busy') });
}

/** Poll this deadline as usual: backoff never changes the event polling cadence. */
export class IdleWait {
  private epoch: string;
  private started: number;
  private emptyTimeouts = 0;
  private completed = false;
  private config: WaitConfig;
  readonly probe: boolean;
  constructor(private session: string | undefined, config: WaitConfig, timeout?: string, now = Date.now()) {
    const base = timeout === undefined ? config.baseTimeoutSecs : Number(timeout);
    if (!Number.isFinite(base) || base < 0) throw new Error('timeout must be nonnegative seconds');
    this.probe = base === 0;
    this.config = { ...config, baseTimeoutSecs: base, maxTimeoutSecs: Math.max(base, config.maxTimeoutSecs) };
    this.epoch = generation(session);
    this.started = now;
    const history = session ? read<History>(sessionKey(session)) : undefined;
    if (history?.generation === this.epoch) this.emptyTimeouts = validCount(history);
  }
  get emptyCount(): number { return this.emptyTimeouts; }
  get timeoutSecs(): number { return this.probe ? 0 : waitTimeoutSecs(this.emptyTimeouts, this.config); }
  /** A reset while armed shortens a backed-off wait to a fresh base wait. */
  remainingMs(now = Date.now()): number {
    const epoch = generation(this.session);
    if (epoch !== this.epoch) { this.epoch = epoch; this.emptyTimeouts = 0; this.started = now; }
    return Math.max(0, this.started + this.timeoutSecs * 1000 - now);
  }
  expired(now = Date.now()): boolean { return this.remainingMs(now) === 0; }
  timedOut(now = Date.now()): void {
    // Probes and a waiter overtaken by a reset cannot advance the history.
    if (!this.session || this.probe || this.completed || generation(this.session) !== this.epoch || !this.expired(now)) return;
    withHistory(this.session, () => {
      if (generation(this.session) !== this.epoch) return;
      const history = read<History>(sessionKey(this.session!));
      const prior = history?.generation === this.epoch ? validCount(history) : 0;
      this.emptyTimeouts = Math.min(Number.MAX_SAFE_INTEGER, Math.max(this.emptyTimeouts, prior) + 1);
      this.completed = true;
      write(sessionKey(this.session!), { generation: this.epoch, emptyTimeouts: this.emptyTimeouts, wakeKeys: history?.wakeKeys } satisfies History);
    });
  }
  /** Stable delivery keys make reminders and repeated digest peeks inert. */
  woke(keys?: readonly string[]): boolean {
    if (!this.session || keys?.length === 0) return false;
    return withHistory(this.session, () => {
      const history = read<History>(sessionKey(this.session!));
      const seen = new Set(history?.wakeKeys ?? []);
      const hashes = keys?.map(key => createHash('sha256').update(key).digest('hex'));
      if (hashes?.every(key => seen.has(key))) return false;
      hashes?.forEach(key => seen.add(key));
      resetWaitBackoff(this.session);
      this.epoch = generation(this.session);
      this.emptyTimeouts = 0;
      this.started = Date.now();
      this.completed = false;
      write(sessionKey(this.session!), { generation: this.epoch, emptyTimeouts: 0, wakeKeys: [...seen] } satisfies History);
      return true;
    });
  }
}
