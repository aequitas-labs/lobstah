import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
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
import { forgetOtherBoats, ownAttentionList, readOtherBoats, writeOtherBoats } from './wharf-attention.js';
import type { OtherBoats } from './wharf-attention.js';

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
/** How often other boats' attention lists are read without a hint, in case one was lost. */
export const MIRROR_ATTENTION_READ_MS = 5 * 60_000;
/** How long the mirror waits before asking again for lists it may not read (no attention grant, or a wharf without them). */
export const MIRROR_ATTENTION_OFF_MS = 30 * 60_000;
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
export type MirrorWharf = Pick<WharfBackend, 'putMirrorSnapshot' | 'mirrorCalls' | 'takeMirrorCall' | 'answerMirrorCall' | 'mirrorFile' | 'putMirrorAttention' | 'mirrorAttention'> & { glass?: string };

export interface WharfMirrorOptions {
  /** The wharf `[glass] mirror` names, for the status file. */
  wharf: string;
  backend: MirrorWharf;
  glass: LocalGlass;
  now?: () => number;
  log?: (message: string) => void;
  /** Where the mirror's status goes; the status file by default. */
  writeStatus?: (status: MirrorStatus) => void;
  /** This glass's loopback port, put with the snapshot for the hosted glass's focus probe. */
  glassPort?: number;
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
  /** This boat's own walking list, from the last snapshot read, and the JSON last put. */
  private attention?: Array<Record<string, unknown>>;
  private attentionPut?: string;
  /** The wharf has no attention routes yet: puts and reads wait until this time. */
  private attentionOffUntil = 0;
  /** Other boats' lists: when they were last read, and until when this boat may not read them. */
  private othersAt = 0;
  private othersOffUntil = 0;
  constructor(private options: WharfMirrorOptions) {
    const prior = readMirrorStatus();
    const same = prior?.wharf === options.wharf ? prior : undefined;
    this.status = { wharf: options.wharf, id: same?.id ?? randomUUID(), calls: 0, at: new Date(this.now()).toISOString(), ...(same?.boat ? { boat: same.boat } : {}), ...(same?.glass ? { glass: same.glass } : {}) };
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
  async pass(hints: { attention?: boolean } = {}): Promise<number> {
    try {
      const { calls, watchedUntil } = await this.options.backend.mirrorCalls();
      this.watchedUntil = watchedUntil ? Date.parse(watchedUntil) : 0;
      if (this.options.backend.glass) this.status.glass = this.options.backend.glass;
      await this.readSnapshot();
      await this.putIfDue();
      for (const call of calls) await this.carryOut(call);
      delete this.status.error;
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : String(error);
      this.options.log?.(`wharf mirror: ${this.status.error}`);
    }
    // The pets' lists come last, on their own: a failure here never holds a relayed call or the snapshot.
    try {
      await this.putAttentionIfChanged();
      await this.readOthersIfDue(hints.attention === true);
    } catch (error) {
      this.options.log?.(`wharf mirror: attention lists: ${error instanceof Error ? error.message : String(error)}`);
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
    if (Array.isArray(snapshot.attention)) this.attention = ownAttentionList(snapshot.attention);
    // The page token opens this glass for writes. The mirror keeps it here, for the calls it carries out, and never sends it.
    if (typeof snapshot.focusToken === 'string') this.token = snapshot.focusToken;
    delete snapshot.focusToken;
    if (this.options.glassPort) snapshot.mirror = { port: this.options.glassPort, id: this.status.id };
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
  /**
   * Put this boat's walking list when it changed since the last put (the
   * first pass always puts), so the other boats' pets walk it. A wharf
   * without the route (404) is asked again in half an hour.
   */
  private async putAttentionIfChanged(): Promise<void> {
    if (!this.attention || this.now() < this.attentionOffUntil) return;
    const json = JSON.stringify(this.attention);
    if (json === this.attentionPut) return;
    try {
      await this.options.backend.putMirrorAttention(this.attention);
      this.attentionPut = json;
    } catch (error) {
      if (!(error instanceof BackendError && error.status === 404)) throw error;
      this.attentionOffUntil = this.now() + MIRROR_ATTENTION_OFF_MS;
    }
  }
  /**
   * Read the other boats' lists on an attention hint, or every five minutes,
   * into the cache `lobstah attention --json` reads. Lists held at an
   * unchanged ETag are kept. Without the grant (403) or the route (404) the
   * cache is removed, so nothing stale walks, and the read waits half an hour.
   */
  private async readOthersIfDue(hinted: boolean): Promise<void> {
    if (this.now() < this.othersOffUntil) return;
    if (!hinted && this.othersAt && this.now() - this.othersAt < MIRROR_ATTENTION_READ_MS) return;
    const held = readOtherBoats();
    const prior = held?.wharf === this.options.wharf ? held : undefined;
    const known = Object.fromEntries((prior?.boats ?? []).map((b) => [b.boat, b.etag]));
    let lists;
    try {
      lists = await this.options.backend.mirrorAttention(known);
    } catch (error) {
      if (!(error instanceof BackendError && (error.status === 403 || error.status === 404))) throw error;
      forgetOtherBoats();
      this.othersOffUntil = this.now() + MIRROR_ATTENTION_OFF_MS;
      return;
    }
    const boats: OtherBoats['boats'] = lists.flatMap((b) => {
      if (!b.unchanged) return [{ ...b, attention: b.attention ?? [] }];
      const kept = prior?.boats.find((p) => p.boat === b.boat);
      return kept ? [{ ...kept, name: b.name, at: b.at }] : [];
    });
    writeOtherBoats({ wharf: this.options.wharf, at: new Date(this.now()).toISOString(), boats });
    this.othersAt = this.now();
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
  const port = glassPort();
  const mirror = new WharfMirror({ wharf, backend: new WharfBackend(scope.location, token), glass: loopbackGlass(port), glassPort: port, log });
  const hints = new WharfWake(scope.location, token, ['mirror-call', 'mirror-watch', 'attention']);
  let stopped = false;
  void (async () => {
    while (!stopped) await hints.wait(await mirror.pass({ attention: hints.heard('attention') }));
  })();
  return {
    stop: () => {
      stopped = true;
      hints.close();
    },
  };
}
