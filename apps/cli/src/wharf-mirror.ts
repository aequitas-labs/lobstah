import * as http from 'node:http';
import { gzipSync } from 'node:zlib';
import {
  BackendError,
  WharfBackend,
  mirrorReadAllowed,
  mirrorWriteAllowed,
  readMirrorStatus,
  wharfCredential,
  writeMirrorStatus,
} from '@lobstah/core';
import type { BackendScope, Config, MirrorStatus, WharfMirrorCall } from '@lobstah/core';
import { glassPort } from './glass-lifecycle.js';
import { WharfWake } from './wharf-wake.js';

/**
 * The mirror: this machine's fleet stays on its own local grounds, and the
 * daemon shows it on a wharf's hosted glass. It puts the local glass's
 * snapshot (without the page token) when it changes, and carries out the
 * reads and writes a person makes there against the local glass, over
 * loopback, one at a time. Only what the local glass itself serves is ever
 * relayed, and never focus.
 */

/** How often a pass runs while a hosted glass is open: a changed snapshot is put within this, and a call waits at most this. */
export const MIRROR_WATCHED_PASS_MS = 2_000;
/** How often a pass runs while no hosted glass is open. */
export const MIRROR_IDLE_PASS_MS = 30_000;
/** How often an unchanged-but-unwatched snapshot is put anyway, so the hosted glass shows a recent copy when it opens. */
export const MIRROR_IDLE_PUT_MS = 5 * 60_000;
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

/** What the mirror needs of its wharf. */
export type MirrorWharf = Pick<WharfBackend, 'putMirrorSnapshot' | 'mirrorCalls' | 'takeMirrorCall' | 'answerMirrorCall' | 'mirrorFile'>;

export interface WharfMirrorOptions {
  /** The wharf `[glass] mirror` names, for the status file. */
  wharf: string;
  backend: MirrorWharf;
  glass: LocalGlass;
  now?: () => number;
  log?: (message: string) => void;
  /** Where the mirror's status goes; the status file by default. */
  writeStatus?: (status: MirrorStatus) => void;
}

/** The mirror's state between passes. */
export class WharfMirror {
  private localEtag?: string;
  private snapshotJson?: string;
  private token?: string;
  private putEtag?: string;
  private putAt = 0;
  private watchedUntil = 0;
  private status: MirrorStatus;
  constructor(private options: WharfMirrorOptions) {
    const prior = readMirrorStatus();
    this.status = { wharf: options.wharf, calls: 0, at: new Date(this.now()).toISOString(), ...(prior?.wharf === options.wharf && prior.boat ? { boat: prior.boat } : {}) };
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  /** Whether a hosted glass is open, as the wharf last said. */
  get watched(): boolean {
    return this.watchedUntil > this.now();
  }
  /**
   * One pass: read the local snapshot, put it when it changed (at once while
   * a hosted glass is open, else at most every five minutes), and carry out
   * the calls waiting. Returns how long to wait before the next pass.
   */
  async pass(): Promise<number> {
    try {
      const { calls, watchedUntil } = await this.options.backend.mirrorCalls();
      this.watchedUntil = watchedUntil ? Date.parse(watchedUntil) : 0;
      await this.readSnapshot();
      await this.putIfDue();
      for (const call of calls) await this.carryOut(call);
      delete this.status.error;
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : String(error);
      this.options.log?.(`wharf mirror: ${this.status.error}`);
    }
    this.status.at = new Date(this.now()).toISOString();
    if (this.watchedUntil) this.status.watchedUntil = new Date(this.watchedUntil).toISOString();
    (this.options.writeStatus ?? writeMirrorStatus)(this.status);
    return this.watched ? MIRROR_WATCHED_PASS_MS : MIRROR_IDLE_PASS_MS;
  }
  /** The local glass's `/data`, kept with its ETag; an unchanged one answers 304 and costs nothing. */
  private async readSnapshot(): Promise<void> {
    const r = await this.options.glass.get('/data', this.localEtag);
    if (r.status === 304) return;
    if (r.status !== 200) throw new Error(`the local glass answered /data with ${r.status}`);
    const snapshot = JSON.parse(r.body.toString('utf8')) as Record<string, unknown>;
    // The page token opens this glass for writes. The mirror keeps it here, for the calls it carries out, and never sends it.
    if (typeof snapshot.focusToken === 'string') this.token = snapshot.focusToken;
    delete snapshot.focusToken;
    this.snapshotJson = JSON.stringify(snapshot);
    this.localEtag = r.etag;
  }
  private async putIfDue(): Promise<void> {
    if (this.snapshotJson === undefined) return;
    // Put at once when the fleet changed and someone is looking; otherwise every five minutes, changed or not.
    const changed = this.localEtag === undefined || this.localEtag !== this.putEtag;
    const due = this.putAt === 0 || this.now() - this.putAt >= MIRROR_IDLE_PUT_MS;
    if (!due && !(changed && this.watched)) return;
    const put = await this.options.backend.putMirrorSnapshot(gzipSync(this.snapshotJson));
    this.putEtag = this.localEtag;
    this.putAt = this.now();
    Object.assign(this.status, { lastPutAt: put.at, etag: put.etag, bytes: put.bytes });
  }
  /** Take one call, run it against the local glass if it is one the hosted glass may make, and answer it. */
  private async carryOut(call: WharfMirrorCall): Promise<void> {
    try {
      await this.options.backend.takeMirrorCall(call.id);
    } catch (error) {
      // Taken already, or expired: someone else's to answer, or no one's.
      if (error instanceof BackendError && (error.status === 409 || error.status === 410)) return;
      throw error;
    }
    let answer: LocalGlassResponse;
    try {
      answer = await this.run(call);
    } catch (error) {
      answer = refusal(502, `The boat could not carry this out: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (answer.body.byteLength > MIRROR_ANSWER_MAX_BYTES) answer = refusal(502, 'The boat’s answer is too large to relay.');
    await this.options.backend.answerMirrorCall(call.id, answer.status, answer.contentType, answer.body);
    this.status.calls += 1;
    this.status.lastCallAt = new Date(this.now()).toISOString();
  }
  private async run(call: WharfMirrorCall): Promise<LocalGlassResponse> {
    // The wharf checks these lists too; the boat checks again, and an unlisted call never reaches the local glass.
    if ('read' in call) {
      if (!mirrorReadAllowed(call.read)) return refusal(403, 'This boat does not relay that read.');
      return this.options.glass.get(call.read);
    }
    if (!mirrorWriteAllowed(call.write.kind)) return refusal(403, 'This boat does not relay that request.');
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
 * otherwise: without it the mirror makes no wharf request at all. The loop
 * runs beside the tick; a wharf that is slow or away never holds it.
 */
export function startWharfMirror(config: Config, log: (message: string) => void = console.log): { stop: () => void } | undefined {
  const wharf = config.glass.mirror;
  if (!wharf) return undefined;
  const scope = mirrorScope(config, wharf);
  const token = wharfCredential(scope);
  if (!token) {
    log(`wharf mirror: no boat credential for ${wharf}; run lobstah wharf login --wharf ${wharf} --mirror`);
    return undefined;
  }
  const mirror = new WharfMirror({ wharf, backend: new WharfBackend(scope.location, token), glass: loopbackGlass(glassPort()), log });
  const hints = new WharfWake(scope.location, token, ['mirror-call', 'mirror-watch']);
  let stopped = false;
  void (async () => {
    while (!stopped) await hints.wait(await mirror.pass());
  })();
  return {
    stop: () => {
      stopped = true;
      hints.close();
    },
  };
}
