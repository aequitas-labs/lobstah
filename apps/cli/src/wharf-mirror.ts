import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  ANSWER_INLINE_MAX_BYTES,
  BackendError,
  WharfBackend,
  encodeFrame,
  lobstahVersion,
  mirrorReadAllowed,
  mirrorWriteAllowed,
  postNotice,
  readMirrorStatus,
  wharfCredential,
  writeMirrorStatus,
} from '@lobstah/core';
import type { BackendScope, ClientSocketMessage, Config, MirrorStatus, WharfAttentionList, WharfMirrorCall } from '@lobstah/core';
import { glassPort } from './glass-lifecycle.js';
import { WharfSocket } from './wharf-socket.js';
import { ownAttentionList, writeOtherBoats } from './wharf-attention.js';

/**
 * The mirror: this machine's fleet stays on its own local grounds, and the
 * daemon shows it on a wharf's hosted glass, over one socket to the wharf.
 * The wharf says when a glass tab is open (`watch`); while one is, the
 * mirror sends the local glass's snapshot (without the page token) each time
 * it changes. Calls a person makes there are pushed to it with all they need;
 * it carries each out against the local glass over loopback, one at a time,
 * and sends the answer back. Its pet's walking list goes out when it
 * changes, and the other boats' lists come in. With no glass open and nothing
 * changing it sends the wharf nothing at all but pings. Only what the local
 * glass itself serves is ever relayed, and never focus.
 */

/** How often the local glass is read while a hosted glass is open: a change reaches the glass within this. */
export const MIRROR_WATCHED_READ_MS = 2_000;
/** How often the local glass is read while none is open, for the pet's walking list. Loopback only: nothing goes to the wharf unless the list changed. */
export const MIRROR_IDLE_READ_MS = 30_000;
/** A disconnected or failing mirror needs attention after ten minutes, once per outage. */
export const MIRROR_STALE_NOTICE_MS = 10 * 60_000;
/** The largest local answer a relayed call carries back. */
const MIRROR_ANSWER_MAX_BYTES = 25 * 1024 * 1024;

/** One answer from the local glass. */
export interface LocalGlassResponse {
  status: number;
  contentType: string;
  body: Buffer;
  etag?: string;
}

/** This machine's glass, as the mirror reaches it. */
export interface LocalGlass {
  /** A read, with the last ETag for `/data` so an unchanged snapshot answers 304. */
  get(path: string, etag?: string): Promise<LocalGlassResponse>;
  /** One `POST /requests`, with the page token, marked as relayed from the hosted glass. */
  request(kind: string, payload: unknown, token: string): Promise<LocalGlassResponse>;
}

/** What the mirror needs of its wharf over HTTP: files a call names, and an answer too large for a frame. */
export type MirrorWharf = Pick<WharfBackend, 'takeMirrorCall' | 'answerMirrorCall' | 'mirrorFile'> & { glass?: string };

/** The mirror's socket to its wharf. */
export interface MirrorChannel {
  connected(): boolean;
  send(message: ClientSocketMessage): boolean;
  sendFrame(frame: Uint8Array): boolean;
}

export interface WharfMirrorOptions {
  /** The wharf `[glass] mirror` names, for the status file. */
  wharf: string;
  backend: MirrorWharf;
  channel: MirrorChannel;
  glass: LocalGlass;
  now?: () => number;
  log?: (message: string) => void;
  /** Where the mirror's status goes; the status file by default. */
  writeStatus?: (status: MirrorStatus) => void;
  /** This glass's loopback port, sent with the snapshot for the hosted glass's focus probe. */
  glassPort?: number;
}

/** The mirror's state between reads of the local glass. */
export class WharfMirror {
  private localEtag?: string;
  private snapshotJson?: string;
  private token?: string;
  /** The local ETag whose snapshot the wharf last got; undefined when it needs one. */
  private sentEtag?: string;
  private watched = false;
  private status: MirrorStatus;
  /** This boat's own walking list, from the last snapshot read, and the JSON last sent. */
  private attention?: Array<Record<string, unknown>>;
  private attentionSent?: string;
  /** Calls carried out, one at a time, and the ids already handled (a resume may push one again). */
  private queue: Promise<void> = Promise.resolve();
  private readonly handled = new Set<string>();
  private healthyAt: number;
  private staleNoticed = false;
  private retryMs = MIRROR_WATCHED_READ_MS;
  constructor(private options: WharfMirrorOptions) {
    const prior = readMirrorStatus();
    const same = prior?.wharf === options.wharf ? prior : undefined;
    this.status = { wharf: options.wharf, id: same?.id ?? randomUUID(), calls: 0, at: new Date(this.now()).toISOString(), ...(same?.boat ? { boat: same.boat } : {}), ...(same?.glass ? { glass: same.glass } : {}) };
    if (options.backend.glass) this.status.glass = options.backend.glass;
    this.healthyAt = this.now();
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  /** Whether a hosted glass is open, as the wharf last said. */
  get watching(): boolean {
    return this.watched;
  }
  /** The wharf says a glass tab is open, or none is. When one opens, it gets the snapshot at once. */
  async onWatch(on: boolean): Promise<void> {
    this.watched = on;
    if (on) {
      this.sentEtag = undefined;
      await this.read();
    } else this.writeStatus();
  }
  /** The socket opened again: the wharf may have missed changes, so the next send is a full one. */
  onReconnect(): void {
    this.sentEtag = undefined;
    this.attentionSent = undefined;
  }
  /** Keep connection failures visible even when reading the local glass still works. */
  onError(error: Error): void {
    this.sentEtag = undefined;
    this.fail(error);
    this.writeStatus();
  }
  /** A call pushed by the wharf: carried out after any before it, once. */
  onCall(call: WharfMirrorCall): Promise<void> {
    if (this.handled.has(call.id)) return this.queue;
    this.handled.add(call.id);
    if (this.handled.size > 1000) this.handled.delete(this.handled.values().next().value!);
    this.queue = this.queue.then(() => this.carryOut(call)).catch((error) => this.fail(error));
    return this.queue;
  }
  /** The other boats' walking lists, pushed to a boat granted attention, into the cache `lobstah attention --json` reads. */
  onAttention(boats: WharfAttentionList[]): void {
    writeOtherBoats({ wharf: this.options.wharf, at: new Date(this.now()).toISOString(), boats: boats.map((b) => ({ ...b, attention: b.attention ?? [] })) });
  }
  /**
   * Read the local glass (loopback), and send the wharf what changed: the
   * snapshot while a glass is open, the walking list whenever it changed.
   * Returns how long to wait before the next read.
   */
  async read(): Promise<number> {
    let failed = false;
    try {
      await this.readSnapshot();
      this.sendSnapshotIfDue();
      this.sendAttentionIfChanged();
      if (this.options.channel.connected()) {
        delete this.status.error;
        this.healthyAt = this.now();
        this.staleNoticed = false;
      }
      this.retryMs = MIRROR_WATCHED_READ_MS;
    } catch (error) {
      failed = true;
      this.fail(error);
    }
    if (!this.staleNoticed && this.now() - this.healthyAt >= MIRROR_STALE_NOTICE_MS) {
      postNotice({ kind: 'wharf-mirror-stale', refId: this.options.wharf,
        text: `Wharf mirror ${this.options.wharf} has been unavailable for 10 minutes. The hosted glass may be out of date. Run lobstah wharf whoami to check the connection.` });
      this.staleNoticed = true;
    }
    this.writeStatus();
    if (failed) {
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, MIRROR_IDLE_READ_MS);
      return delay;
    }
    return this.watched ? MIRROR_WATCHED_READ_MS : MIRROR_IDLE_READ_MS;
  }
  private fail(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    if (this.status.error !== reason) this.options.log?.(`wharf mirror: ${reason}`);
    this.status.error = reason;
  }
  private writeStatus(): void {
    this.status.at = new Date(this.now()).toISOString();
    this.status.connected = this.options.channel.connected();
    if (this.watched) this.status.watchedUntil = new Date(this.now() + MIRROR_IDLE_READ_MS).toISOString();
    else delete this.status.watchedUntil;
    (this.options.writeStatus ?? writeMirrorStatus)(this.status);
  }
  /** The local glass's `/data`, kept with its ETag; an unchanged one answers 304 and costs nothing. */
  private async readSnapshot(): Promise<void> {
    const r = await this.options.glass.get('/data', this.localEtag);
    if (r.status === 304) return;
    if (r.status !== 200) throw new Error(`the local glass answered /data with ${r.status}`);
    const snapshot = JSON.parse(r.body.toString('utf8')) as Record<string, unknown>;
    if (Array.isArray(snapshot.attention)) this.attention = ownAttentionList(snapshot.attention);
    // The page token opens this glass for writes. The mirror keeps it here, for the calls it carries out, and never sends it.
    if (typeof snapshot.focusToken === 'string') this.token = snapshot.focusToken;
    delete snapshot.focusToken;
    if (this.options.glassPort) snapshot.mirror = { port: this.options.glassPort, id: this.status.id };
    this.snapshotJson = JSON.stringify(snapshot);
    this.localEtag = r.etag;
  }
  /** Send the snapshot while a glass is open and it changed since the wharf last got it; never while none is. */
  private sendSnapshotIfDue(): void {
    if (!this.watched || this.snapshotJson === undefined) return;
    if (this.sentEtag !== undefined && this.sentEtag === this.localEtag) return;
    const gzip = gzipSync(this.snapshotJson);
    const at = new Date(this.now()).toISOString();
    const frame = encodeFrame({ t: 'snapshot', boat: this.status.boat ?? '', name: '', at, etag: this.localEtag ?? '' }, gzip);
    if (!this.options.channel.sendFrame(frame)) return;
    this.sentEtag = this.localEtag ?? '';
    Object.assign(this.status, { lastPutAt: at, etag: this.localEtag ?? '', bytes: gzip.byteLength });
  }
  /** Send this boat's walking list when it changed since the last send (the first read always sends). */
  private sendAttentionIfChanged(): void {
    if (!this.attention) return;
    const json = JSON.stringify(this.attention);
    if (json === this.attentionSent) return;
    if (this.options.channel.send({ t: 'attention', attention: this.attention })) this.attentionSent = json;
  }
  /** Run one call against the local glass if it is one the hosted glass may make, and answer it: in a frame, or over HTTP when too large. */
  private async carryOut(call: WharfMirrorCall): Promise<void> {
    let answer: LocalGlassResponse;
    try {
      answer = await this.run(call);
    } catch (error) {
      answer = refusal(502, `The boat could not carry this out: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (answer.body.byteLength > MIRROR_ANSWER_MAX_BYTES) answer = refusal(502, 'The boat’s answer is too large to relay.');
    const frame = encodeFrame({ t: 'answer', id: call.id, status: answer.status, contentType: answer.contentType }, answer.body);
    if (answer.body.byteLength > ANSWER_INLINE_MAX_BYTES || !this.options.channel.sendFrame(frame)) {
      try {
        await this.options.backend.takeMirrorCall(call.id);
      } catch (error) {
        // Taken already, or expired: someone else's to answer, or no one's.
        if (error instanceof BackendError && (error.status === 409 || error.status === 410)) return;
        throw error;
      }
      await this.options.backend.answerMirrorCall(call.id, answer.status, answer.contentType, answer.body);
    }
    this.status.calls += 1;
    this.status.lastCallAt = new Date(this.now()).toISOString();
    this.writeStatus();
  }
  private async run(call: WharfMirrorCall): Promise<LocalGlassResponse> {
    // The wharf checks these lists too; the boat checks again, and an unlisted call never reaches the local glass.
    if ('read' in call) {
      if (!mirrorReadAllowed(call.read)) return refusal(403, 'This boat does not relay that read.');
      return this.options.glass.get(call.read);
    }
    if (!mirrorWriteAllowed(call.write.kind)) return refusal(403, 'This boat does not relay that request.');
    if (!this.token) await this.readSnapshot().catch(() => undefined);
    if (!this.token) return refusal(503, 'The boat has not read its glass yet; try again.');
    let payload = call.write.payload;
    if (call.files?.length) {
      // Files a person attached on the hosted glass, as the local glass takes them: name and base64 data.
      const files = [];
      for (const id of call.files) {
        const file = await this.options.backend.mirrorFile(id);
        files.push({ name: file.name, data: Buffer.from(file.bytes).toString('base64') });
      }
      payload = { ...(payload as Record<string, unknown>), files };
    }
    return this.options.glass.request(call.write.kind, payload, this.token);
  }
}

/** A refusal the boat makes itself, in the local glass's shape. */
function refusal(status: number, reason: string): LocalGlassResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ ok: false, reason })) };
}

/** This machine's glass on its loopback port, with the same host and origin its own page uses. */
export function loopbackGlass(port: number): LocalGlass {
  const host = `127.0.0.1:${port}`;
  const send = (method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: string): Promise<LocalGlassResponse> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...headers }, timeout: 30_000 }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MIRROR_ANSWER_MAX_BYTES) return void req.destroy(new Error('the local glass answer is too large'));
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 502,
            contentType: String(res.headers['content-type'] ?? 'application/octet-stream'),
            body: Buffer.concat(chunks),
            ...(typeof res.headers.etag === 'string' ? { etag: res.headers.etag } : {}),
          }),
        );
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('the local glass did not answer')));
      req.on('error', reject);
      req.end(body);
    });
  return {
    get: (path, etag) => send('GET', path, etag ? { 'If-None-Match': etag } : {}),
    request: (kind, payload, token) =>
      send('POST', '/requests', { Origin: `http://${host}`, 'Content-Type': 'application/json', 'X-Lobstah-Token': token, 'X-Lobstah-Relay': 'wharf' }, JSON.stringify({ kind, payload })),
  };
}

/** The scope a mirror's credential is stored under: its wharf, with no grounds of its own. */
export function mirrorScope(config: Config, wharf: string): Extract<BackendScope, { kind: 'wharf' }> {
  const location = config.wharves?.[wharf];
  if (!location) throw new Error(`no wharf ${wharf} in [wharves]`);
  return { kind: 'wharf', wharf, location, grounds: `mirror:${wharf}`, repos: [] };
}

/**
 * Start the daemon's mirror when `[glass] mirror` names a wharf, and not
 * otherwise: without it the mirror makes no wharf request at all. Its
 * socket stays open (reconnecting after a drop), and its reads of the local
 * glass run beside the tick; a wharf that is slow or away never holds it.
 */
export function startWharfMirror(config: Config, log: (message: string) => void = console.log): { stop: () => void } | undefined {
  const wharf = config.glass.mirror;
  if (!wharf) return undefined;
  const scope = mirrorScope(config, wharf);
  const credential = (): string => wharfCredential(scope);
  const port = glassPort();
  let mirror: WharfMirror | undefined;
  const socket = new WharfSocket(scope.location, credential, {
    client: lobstahVersion(),
    onState: (open) => {
      if (open) mirror?.onReconnect();
    },
    onError: (error) => mirror?.onError(error),
    onMessage: (message) => {
      if (!mirror) return;
      if (message.t === 'watch') void mirror.onWatch(message.on);
      else if (message.t === 'call') void mirror.onCall(message.call);
      else if (message.t === 'attention') mirror.onAttention(message.boats);
      else if (message.t === 'error') mirror.onError(new Error(message.reason));
    },
  });
  mirror = new WharfMirror({ wharf, backend: new WharfBackend(scope.location, credential), channel: socket, glass: loopbackGlass(port), glassPort: port, log });
  socket.start();
  let stopped = false;
  let sleeping: ReturnType<typeof setTimeout> | undefined;
  void (async () => {
    while (!stopped) {
      const delay = await mirror!.read();
      await new Promise<void>((resolve) => { sleeping = setTimeout(resolve, delay); });
    }
  })();
  return {
    stop: () => {
      stopped = true;
      if (sleeping) clearTimeout(sleeping);
      socket.close();
    },
  };
}
