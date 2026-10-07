import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { configPath, loadConfig } from './config.js';
import { lobstahHome } from './paths.js';
import { readStatsStore } from './stats.js';
import { generatedTrapNames, TRAP_NAME_RE } from './trap-names.js';
import { lobstahVersion } from './version.js';
import { liveHelms } from './helm.js';
import { listTraps } from './soak.js';
import { sessionWorker } from './session-workers.js';
import { sanitizeWorker, workerProfile } from './worker-profile.js';
import type { WorkerProfile } from './worker-profile.js';
import type { WorkerCatches } from './stats.js';

/**
 * Anonymous telemetry: one small daily aggregate of catch counts, sent by the
 * daemon (never by a hook) at most once per UTC day.
 *
 * - The payload is TELEMETRY_FIELDS and nothing else: no repository, path,
 *   brief, custom/unknown trap name, session, PR, host or user. Generated
 *   trap names with recorded provenance may carry UTC-day counts. The install
 *   id is a random UUID, unrelated to the machine, user or any repository.
 * - Any one switch turns it off: `[telemetry] share = false` in config.toml,
 *   LOBSTAH_TELEMETRY=0, DO_NOT_TRACK=1, or CI set.
 * - Nothing is sent until a first-run notice has been shown on an
 *   interactive run, and nothing is sent while TELEMETRY_ENDPOINT is empty.
 * - A send is fire and forget: 2 s timeout, no retry, silent on errors.
 */

/** Where the daily payload goes. Empty: this build sends nothing. */
export const TELEMETRY_ENDPOINT = '';

export const TELEMETRY_SCHEMA = 1;

/** The only keys a payload may carry. The Worker rejects any other key. */
export const TELEMETRY_FIELDS = ['schema', 'version', 'os', 'arch', 'installId', 'date', 'catches', 'helm', 'traps', 'byWorker'] as const;
export const TELEMETRY_MAX_TRAPS = 100;
export const TELEMETRY_MAX_WORKERS = 100;

export interface TelemetryPayload {
  schema: typeof TELEMETRY_SCHEMA;
  /** The lobstah version, e.g. 0.6.9. */
  version: string;
  /** OS family: macos | linux | windows | other. */
  os: string;
  /** CPU architecture: x64 | arm64 | other. */
  arch: string;
  /** A random UUID made on this machine on first run (telemetry.json). */
  installId: string;
  /** The UTC date of the send, YYYY-MM-DD. */
  date: string;
  /** UTC-day and all-time catches, including headless and omitted traps. */
  catches: { today: number; total: number };
  /** At most 100 automatically generated names, with positive UTC-day counts. */
  helm: WorkerProfile | null;
  traps: Array<WorkerCatches & { name: string }>;
  /** Headless UTC-day catches, grouped by safe worker settings (max 100). */
  byWorker: WorkerCatches[];
}

/** Local telemetry state, `~/.lobstah/telemetry.json`. Never sent, apart from installId. */
export interface TelemetryState {
  installId: string;
  /** When the first-run notice was shown on an interactive run. Sending waits for it. */
  noticeShownAt?: string;
  /** The UTC date of the last send attempt: one attempt per UTC day. */
  lastSentDate?: string;
  /**
   * A CLI run saw an environment off switch (LOBSTAH_TELEMETRY=0,
   * DO_NOT_TRACK=1, CI). The daemon runs as a service without the shell's
   * environment, so the CLI records the switch here for it. An interactive
   * run without such a switch clears it.
   */
  envOff?: { switch: string; at: string };
}

export function telemetryStatePath(): string {
  return path.join(lobstahHome(), 'telemetry.json');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function readTelemetryState(): TelemetryState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(telemetryStatePath(), 'utf8')) as Partial<TelemetryState>;
    if (typeof s.installId !== 'string' || !UUID.test(s.installId)) return undefined;
    return {
      installId: s.installId,
      ...(typeof s.noticeShownAt === 'string' ? { noticeShownAt: s.noticeShownAt } : {}),
      ...(typeof s.lastSentDate === 'string' ? { lastSentDate: s.lastSentDate } : {}),
      ...(s.envOff && typeof s.envOff.switch === 'string' && typeof s.envOff.at === 'string' ? { envOff: { switch: s.envOff.switch, at: s.envOff.at } } : {}),
    };
  } catch {
    return undefined;
  }
}

function writeTelemetryState(state: TelemetryState): void {
  const file = telemetryStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The state, creating the install id (a random v4 UUID) on first use. */
export function ensureTelemetryState(): TelemetryState {
  const existing = readTelemetryState();
  if (existing) return existing;
  const state: TelemetryState = { installId: crypto.randomUUID() };
  writeTelemetryState(state);
  return state;
}

function updateTelemetryState(change: (s: TelemetryState) => TelemetryState): TelemetryState {
  const next = change(ensureTelemetryState());
  writeTelemetryState(next);
  return next;
}

/** The environment off switch in effect, if any, by name. */
export function envOffSwitch(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const lobstah = env.LOBSTAH_TELEMETRY?.trim().toLowerCase();
  if (lobstah !== undefined && ['0', 'false', 'off', 'no'].includes(lobstah)) return 'LOBSTAH_TELEMETRY';
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt !== undefined && dnt !== '' && dnt !== '0' && dnt !== 'false') return 'DO_NOT_TRACK';
  if (env.CI !== undefined) return 'CI';
  return undefined;
}

/**
 * `[telemetry] share` from config.toml: true or false when set; undefined
 * when absent. An unreadable config, or a value that is not a boolean,
 * counts as false: when in doubt, nothing is sent.
 */
export function configShare(): boolean | undefined {
  let raw: Record<string, unknown>;
  try {
    const file = configPath();
    if (!fs.existsSync(file)) return undefined;
    raw = parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  const table = raw.telemetry;
  if (table === undefined) return undefined;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return false;
  const share = (table as Record<string, unknown>).share;
  if (share === undefined) return undefined;
  return share === true;
}

export interface TelemetryStatus {
  /** Whether the daemon would send today (endpoint and notice aside). */
  sharing: boolean;
  /** Each off switch in effect, e.g. `config: [telemetry] share = false`. */
  offBy: string[];
  /** The endpoint, or empty when this build sends nothing. */
  endpoint: string;
  noticeShown: boolean;
  installId?: string;
  lastSentDate?: string;
}

export function telemetryStatus(env: NodeJS.ProcessEnv = process.env, endpoint = TELEMETRY_ENDPOINT): TelemetryStatus {
  const offBy: string[] = [];
  if (configShare() === false) offBy.push(`config: [telemetry] share = false (${configPath()})`);
  const sw = envOffSwitch(env);
  if (sw) offBy.push(`env: ${sw}`);
  const state = readTelemetryState();
  if (state?.envOff && state.envOff.switch !== sw) offBy.push(`env: ${state.envOff.switch} (seen by a CLI run at ${state.envOff.at})`);
  return {
    sharing: offBy.length === 0,
    offBy,
    endpoint,
    noticeShown: !!state?.noticeShownAt,
    ...(state ? { installId: state.installId } : {}),
    ...(state?.lastSentDate ? { lastSentDate: state.lastSentDate } : {}),
  };
}

function osFamily(platform: string = process.platform): string {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'other';
}

function archFamily(arch: string = process.arch): string {
  return arch === 'x64' || arch === 'arm64' ? arch : 'other';
}

export function utcDate(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Exactly what a send would carry, built from stats.json. */
export function buildTelemetryPayload(installId: string, now: number = Date.now()): TelemetryPayload {
  const store = readStatsStore(now);
  const date = utcDate(now);
  const utc = store.utc?.date === date ? store.utc : undefined;
  const perName = new Map<string, WorkerCatches>();
  const names = generatedTrapNames();
  const registrations = new Map(listTraps().map((t) => [t.trapId, t]));
  for (const [address, today] of Object.entries(utc?.perTrap ?? {})) {
    if (!address.startsWith('wt:') || !Number.isSafeInteger(today) || today <= 0) continue;
    const name = names.get(address.slice(3));
    if (name && name.length >= 5 && name.length <= 17 && TRAP_NAME_RE.test(name)) {
      const reg = registrations.get(address.slice(3));
      const worker = reg ? sessionWorker(reg.sessionId, reg.harness) : sanitizeWorker(utc?.trapWorkers?.[address]);
      const previous = perName.get(name);
      // A reused name with conflicting settings must not acquire guessed metadata.
      perName.set(name, { ...(previous && JSON.stringify(sanitizeWorker(previous)) !== JSON.stringify(worker) ? workerProfile() : worker), today: (previous?.today ?? 0) + today });
    }
  }
  const byWorker = (utc?.byWorker ?? []).map((w) => ({ ...sanitizeWorker(w), today: w.today }));
  // Old/cull-lost evidence stays attributable as unknown, not as a guessed model.
  const headless = Math.max(0, (utc?.catches ?? 0) - Object.values(utc?.perTrap ?? {}).reduce((a, b) => a + b, 0));
  const missing = headless - byWorker.reduce((n, w) => n + w.today, 0);
  if (missing > 0) byWorker.push({ ...workerProfile(), today: missing });
  const helms = liveHelms(loadConfig().helm.ttlSecs * 1000, now);
  // An install can oversee multiple grounds. Never invent one representative.
  const helm = helms.length === 1 ? sessionWorker(helms[0]!.sessionId, helms[0]!.harness) : null;
  return {
    schema: TELEMETRY_SCHEMA,
    version: lobstahVersion(),
    os: osFamily(),
    arch: archFamily(),
    installId,
    date,
    catches: { today: utc?.catches ?? 0, total: store.totalCatches },
    helm,
    traps: [...perName].map(([name, row]) => ({ name, ...row })).sort((a, b) => b.today - a.today || a.name.localeCompare(b.name)).slice(0, TELEMETRY_MAX_TRAPS),
    byWorker: boundedWorkers(byWorker),
  };
}

/** The payload as sent: the allowed keys only, in a fixed order. */
export function serializeTelemetryPayload(p: TelemetryPayload): string {
  const out: Record<string, unknown> = {};
  for (const key of TELEMETRY_FIELDS) out[key] = p[key];
  out.catches = { today: p.catches.today, total: p.catches.total };
  out.helm = p.helm ? sanitizeWorker(p.helm) : null;
  out.traps = p.traps
    .filter((t) => typeof t.name === 'string' && t.name.length >= 5 && t.name.length <= 17 && t.name.trim() === t.name && TRAP_NAME_RE.test(t.name) && Number.isSafeInteger(t.today) && t.today > 0)
    .slice(0, TELEMETRY_MAX_TRAPS).map((t) => ({ name: t.name, today: t.today, ...sanitizeWorker(t) }));
  out.byWorker = boundedWorkers(p.byWorker);
  return JSON.stringify(out);
}

function boundedWorkers(rows: readonly WorkerCatches[]): WorkerCatches[] {
  const grouped = new Map<string, WorkerCatches>();
  for (const r of rows) {
    if (!Number.isSafeInteger(r.today) || r.today <= 0) continue;
    const worker = sanitizeWorker(r);
    const key = JSON.stringify(worker);
    const previous = grouped.get(key);
    grouped.set(key, { ...worker, today: (previous?.today ?? 0) + r.today });
  }
  const sorted = [...grouped.values()].sort((a, b) => b.today - a.today || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (sorted.length <= TELEMETRY_MAX_WORKERS) return sorted;
  const kept = sorted.slice(0, TELEMETRY_MAX_WORKERS - 1);
  // Fold overflow into unknown, retaining every headless catch.
  const unknown = workerProfile();
  const remainder = sorted.slice(TELEMETRY_MAX_WORKERS - 1).reduce((n, r) => n + r.today, 0);
  const existing = kept.find((r) => JSON.stringify(sanitizeWorker(r)) === JSON.stringify(unknown));
  if (existing) existing.today += remainder;
  else kept.push({ ...unknown, today: remainder });
  return kept;
}

export const TELEMETRY_NOTICE = `lobstah telemetry: once a day the lobstah daemon sends an anonymous count of
catches (dispatches finished done): the UTC-day count and the all-time total,
with the lobstah version, OS family, CPU architecture, the UTC date, and a
random install id made on this machine. It also sends up to 100 automatically
generated trap names with recorded provenance and their UTC-day counts.
It includes the signed-on helm's and traps' harness, known model and fixed-choice
config (reasoning effort and permission mode), plus headless counts by those
settings. Missing observations are null; custom/unrecognized models are other.
Custom names (--name) and older names with unknown provenance stay local;
their catches still count in the totals. Names are not hashed. It never sends
repository names or paths, code, briefs, session ids, PR URLs, hostnames or user names.
See it exactly: lobstah telemetry show. Details: PRIVACY.md.
Turn it off with any one of: lobstah telemetry disable · [telemetry] share = false
in ~/.lobstah/config.toml · LOBSTAH_TELEMETRY=0 · DO_NOT_TRACK=1 · CI set.`;

/**
 * Called on every CLI run. Records an environment off switch for the daemon
 * (or clears it on an interactive run without one). On an interactive run
 * with sharing on and an endpoint set, prints the first-run notice once and
 * records that it was shown. Returns the notice when it printed it. Never
 * throws.
 */
export function telemetryCliRun(opts: {
  interactive: boolean;
  /** False records or clears the environment switch only (the telemetry command). */
  notice?: boolean;
  write: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  endpoint?: string;
  now?: number;
}): string | undefined {
  try {
    const env = opts.env ?? process.env;
    const endpoint = opts.endpoint ?? TELEMETRY_ENDPOINT;
    const at = new Date(opts.now ?? Date.now()).toISOString();
    const sw = envOffSwitch(env);
    const state = readTelemetryState();
    if (sw) {
      if (state?.envOff?.switch !== sw) updateTelemetryState((s) => ({ ...s, envOff: { switch: sw, at } }));
      return undefined;
    }
    if (!opts.interactive) return undefined;
    if (state?.envOff) updateTelemetryState(({ envOff: _cleared, ...s }) => s);
    if (opts.notice === false || !endpoint || state?.noticeShownAt || configShare() === false) return undefined;
    opts.write(`${TELEMETRY_NOTICE}\n`);
    updateTelemetryState((s) => ({ ...s, noticeShownAt: at }));
    return TELEMETRY_NOTICE;
  } catch {
    return undefined;
  }
}

/** Why a daemon pass sent nothing, or `sent`. */
export type TelemetrySendResult = 'sent' | 'no-endpoint' | 'off' | 'no-notice' | 'already-sent' | 'in-flight' | 'error';

let sending = false;

/**
 * The daemon's daily send. At most one attempt per UTC day: the date is
 * recorded before the request, so a failure waits for tomorrow. Resolves,
 * never rejects; network errors are silent.
 */
export async function sendTelemetry(opts: {
  env?: NodeJS.ProcessEnv;
  endpoint?: string;
  now?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<TelemetrySendResult> {
  const endpoint = opts.endpoint ?? TELEMETRY_ENDPOINT;
  if (!endpoint) return 'no-endpoint';
  if (sending) return 'in-flight';
  try {
    const now = opts.now ?? Date.now();
    if (!telemetryStatus(opts.env ?? process.env, endpoint).sharing) return 'off';
    const state = readTelemetryState();
    if (!state?.noticeShownAt) return 'no-notice';
    const date = utcDate(now);
    if (state.lastSentDate === date) return 'already-sent';
    const body = serializeTelemetryPayload(buildTelemetryPayload(state.installId, now));
    updateTelemetryState((s) => ({ ...s, lastSentDate: date }));
    sending = true;
    const res = await (opts.fetch ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    });
    return res.ok ? 'sent' : 'error';
  } catch {
    return 'error';
  } finally {
    sending = false;
  }
}

/**
 * Set `[telemetry] share` in config.toml, keeping the rest of the file as
 * written. Fails rather than guess when the result does not read back.
 */
export function setTelemetryShare(share: boolean): void {
  const file = configPath();
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split('\n');
  const header = lines.findIndex((l) => /^\s*\[\s*telemetry\s*\]\s*(#.*)?$/.test(l));
  const line = `share = ${share}`;
  let next: string;
  if (header === -1) {
    const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
    next = `${base}${base ? '\n' : ''}[telemetry]\n${line}\n`;
  } else {
    let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
    if (end === -1) end = lines.length;
    const existing = lines.findIndex((l, i) => i > header && i < end && /^\s*share\s*=/.test(l));
    if (existing === -1) lines.splice(header + 1, 0, line);
    else lines[existing] = line;
    next = lines.join('\n');
  }
  let readBack: unknown;
  try {
    readBack = ((parse(next) as Record<string, unknown>).telemetry as Record<string, unknown> | undefined)?.share;
  } catch {
    readBack = undefined;
  }
  if (readBack !== share) throw new Error(`could not set [telemetry] share in ${file} — set \`share = ${share}\` under [telemetry] by hand`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);
}

/** `lobstah telemetry enable`: share on, and the notice counts as shown. */
export function enableTelemetry(now: number = Date.now()): void {
  setTelemetryShare(true);
  updateTelemetryState((s) => ({ ...s, noticeShownAt: s.noticeShownAt ?? new Date(now).toISOString() }));
}

export function disableTelemetry(): void {
  setTelemetryShare(false);
}
