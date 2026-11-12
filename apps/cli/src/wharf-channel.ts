import { randomUUID } from 'node:crypto';
import { BackendError, USAGE_EVERY_MS, lobstahVersion, wharfCredential, wharfFor } from '@lobstah/core';
import type { BackendEvent, BackendScope, HostedRefresh, ServerSocketMessage } from '@lobstah/core';
import { WharfSocket } from './wharf-socket.js';

/**
 * The daemon's one socket to each wharf account its grounds use, and what
 * it has heard. The wharf pushes events (and a nudge for card answers); each
 * reader asks whether its topic changed since it last read, and reads over
 * HTTP only then. While the socket is down, every topic comes due once each
 * FALLBACK_READ_MS instead, so a boat still works with the wharf's socket
 * away. Commands (renewals, card restatements) go on the socket and fall
 * back to HTTP with the same idempotency key.
 */

type Scope = Extract<BackendScope, { kind: 'wharf' }>;

/** While a socket is down, each topic comes due this often: the old pollers' slowest cadence. */
export const FALLBACK_READ_MS = 30_000;

/**
 * What a reader may read again:
 * - `dispatches`: the job list (any event about a job);
 * - `documents`: published decisions and reports;
 * - `claim`: work this boat may claim (queued, requeued or newly servable);
 * - `starts`: trap starts the glass authorized;
 * - `answers`: answers people gave this boat's cards;
 * - `messages:<job>`: one job's inbox;
 * - `job:<job>`: one job's claim, which a cancel or a lost lease ends;
 * - `usage`: the coarse usage facts, which no event moves (read on open and each USAGE_EVERY_MS).
 */
export type ChannelTopic = 'dispatches' | 'documents' | 'claim' | 'starts' | 'answers' | 'usage' | `messages:${string}` | `job:${string}`;

/** Which topics one event moves. */
export function eventTopics(event: Pick<BackendEvent, 'kind' | 'dispatchId'>): ChannelTopic[] {
  const topics: ChannelTopic[] = [];
  const job = event.dispatchId;
  if (job) topics.push('dispatches');
  if (['queued', 'lease-lost', 'servable'].includes(event.kind)) topics.push('claim');
  if (event.kind === 'trap-start-authorized') topics.push('starts');
  if (['decision', 'report', 'decision-answer', 'decision-withdrawn', 'file-uploaded'].includes(event.kind)) topics.push('documents');
  if (job && event.kind === 'message') topics.push(`messages:${job}`);
  if (job && ['cancelled', 'lease-lost', 'claimed', 'servable', 'unservable'].includes(event.kind)) topics.push(`job:${job}`);
  return topics;
}

/** The narrow socket a channel needs; a WharfSocket in the daemon, a fake in tests. */
export interface ChannelSocket {
  start(): void;
  connected(): boolean;
  command: WharfSocket['command'];
  close(): void;
}

export class WharfChannel {
  /** Each topic's change count, and how many times the socket has opened: a reopen makes every topic due. */
  private readonly versions = new Map<string, number>();
  private opens = 0;
  /** What each reader last saw of a topic, and when it last asked. */
  private readonly seen = new Map<string, { version: string; at: number }>();
  readonly socket: ChannelSocket;
  constructor(socket: (on: { message: (m: ServerSocketMessage) => void; state: (open: boolean) => void }) => ChannelSocket, private readonly now: () => number = Date.now) {
    this.socket = socket({ message: (m) => this.heard(m), state: (open) => { if (open) this.opens += 1; } });
  }

  /** Whether the socket is open now. */
  connected(): boolean {
    return this.socket.connected();
  }

  /**
   * Whether `reader` should read `topic` now: it never has, the topic moved
   * since it last did, the socket reopened since (it may have missed a
   * push), or the socket is down and FALLBACK_READ_MS passed. Asking marks
   * the topic read for that reader.
   */
  due(topic: ChannelTopic, reader: string, everyMs?: number): boolean {
    const key = `${topic}\u0000${reader}`;
    const version = `${this.opens}:${this.versions.get(topic) ?? 0}`;
    const last = this.seen.get(key);
    const now = this.now();
    const age = last ? now - last.at : Infinity;
    const due = !last || last.version !== version || (!this.connected() && age >= FALLBACK_READ_MS) || (everyMs !== undefined && age >= everyMs);
    if (due) this.seen.set(key, { version, at: now });
    return due;
  }

  /** Forget a reader's topic: a finished job's inbox or claim. */
  forget(topic: ChannelTopic, reader: string): void {
    this.seen.delete(`${topic}\u0000${reader}`);
  }

  /**
   * Run one route on the socket; undefined when the socket could not (the
   * caller then sends it over HTTP with the same key).
   */
  async command(method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, key: string = randomUUID()): Promise<{ status: number; value: unknown } | undefined> {
    return this.socket.command({ id: key, method, path, body });
  }

  close(): void {
    this.socket.close();
  }

  private heard(message: ServerSocketMessage): void {
    if (message.t === 'event') for (const event of message.events) for (const topic of eventTopics(event)) this.bump(topic);
    if (message.t === 'nudge' && message.read === 'cards/answers') this.bump('answers');
  }

  private bump(topic: ChannelTopic): void {
    this.versions.set(topic, (this.versions.get(topic) ?? 0) + 1);
  }
}

/** The daemon's channels, one per wharf account and credential. */
const channels = new Map<string, WharfChannel>();

/** The key of a scope's account and credential: grounds on one account with one boat share a socket. */
function channelKey(scope: Scope, credential: string): string {
  return JSON.stringify([scope.location.url, scope.location.account, credential]);
}

/** Open (once) the daemon's channel for a grounds bound to a wharf. Without a credential there is none. */
export function openChannel(scope: Scope): WharfChannel | undefined {
  let credential: string | undefined;
  try {
    credential = wharfCredential(scope);
  } catch {
    return undefined;
  }
  if (!credential) return undefined;
  const key = channelKey(scope, credential);
  let channel = channels.get(key);
  if (!channel) {
    channel = new WharfChannel(({ message, state }) => new WharfSocket(scope.location, credential!, { client: lobstahVersion(), onMessage: message, onState: state }));
    channel.socket.start();
    channels.set(key, channel);
  }
  return channel;
}

/** The channel already open for a scope, if the daemon opened one. A one-shot command has none. */
export function channelFor(scope: Scope): WharfChannel | undefined {
  try {
    const credential = wharfCredential(scope);
    return credential ? channels.get(channelKey(scope, credential)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The daemon's refresh of its hosted views: each grounds' jobs and documents
 * when its socket heard they changed, usage on open and hourly. A grounds
 * with no channel reads every FALLBACK_READ_MS.
 */
export function hostedRefresh(now: () => number = Date.now): HostedRefresh {
  const unsocketed = new Map<string, number>();
  return {
    due: (scope, part) => {
      if (scope.kind !== 'wharf') return false;
      const channel = channelFor(scope);
      if (channel) return channel.due(part, `hosted:${scope.grounds}`, part === 'usage' ? USAGE_EVERY_MS : undefined);
      const key = `${scope.grounds}\u0000${part}`, last = unsocketed.get(key);
      if (last !== undefined && now() - last < FALLBACK_READ_MS) return false;
      unsocketed.set(key, now());
      return true;
    },
    live: (scope) => scope.kind === 'wharf' && !!channelFor(scope)?.connected(),
    read: async (scope, path) => {
      if (scope.kind !== 'wharf') throw new Error('this grounds uses local files');
      const result = await channelFor(scope)?.command('GET', path, {});
      if (!result) return wharfFor(scope).request(path);
      if (result.status >= 400) throw new BackendError(result.status, String((result.value as { error?: unknown })?.error ?? `wharf answered ${result.status}`));
      return result.value;
    },
  };
}

/** Close every channel (the daemon stopping, or a test). */
export function closeChannels(): void {
  for (const channel of channels.values()) channel.close();
  channels.clear();
}

/**
 * Send one command on the scope's socket, or over HTTP when there is no
 * socket or it could not: the same key either way, so it applies once.
 */
export async function sendCommand(scope: Scope, path: string, body: unknown, key: string = randomUUID()): Promise<unknown> {
  const result = await channelFor(scope)?.command('POST', path, body, key);
  if (result && result.status >= 200 && result.status < 300) return result.value;
  if (result && result.status >= 400 && result.status < 500 && result.status !== 429) {
    throw new BackendError(result.status, String((result.value as { error?: unknown })?.error ?? `wharf answered ${result.status}`));
  }
  return wharfFor(scope).request(path, body, key);
}
