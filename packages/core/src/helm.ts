import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.js';
import { lobstahHome } from './paths.js';

/**
 * The helm: one orchestrator session per grounds. `lobstah man helm` writes
 * the registration, the session's park (`man haul`) and brief heartbeat it,
 * and `man relieve` (or a deliberate `--take` by another session) removes it.
 * One file per grounds is the enforcement — the data model cannot hold two.
 */
export interface HelmRegistration {
  sessionId: string;
  grounds: string;
  /** The repo keys this helm oversees, resolved from config at sign-on. */
  repos: string[];
  signedOnAt: string;
  heartbeatAt: string;
  /** Set when this registration displaced a live predecessor via --take. */
  tookFrom?: { sessionId: string; at: string };
}

/** Left for a displaced session so its next park tells it to stand down. */
export interface RelievedNotice {
  sessionId: string;
  grounds: string;
  by: string;
  at: string;
}

/** A named territory resolved from config: grounds name plus its repo keys. */
export interface Grounds {
  name: string;
  repos: string[];
}

function helmDir(): string {
  return path.join(lobstahHome(), 'helm');
}

function relievedDir(): string {
  return path.join(helmDir(), '.relieved');
}

function helmPath(grounds: string): string {
  return path.join(helmDir(), `${grounds}.json`);
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function readHelm(grounds: string): HelmRegistration | undefined {
  try {
    return JSON.parse(fs.readFileSync(helmPath(grounds), 'utf8')) as HelmRegistration;
  } catch {
    return undefined;
  }
}

export function listHelms(): HelmRegistration[] {
  try {
    return fs
      .readdirSync(helmDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(helmDir(), f), 'utf8')) as HelmRegistration);
  } catch {
    return [];
  }
}

/** The helm registration held by this session, if any. */
export function helmOf(sessionId: string): HelmRegistration | undefined {
  return listHelms().find((h) => h.sessionId === sessionId);
}

/** Helm registrations whose heartbeat is within ttl — the claimed seats. */
export function liveHelms(ttlMs: number, now = Date.now()): HelmRegistration[] {
  return listHelms().filter((h) => now - (Date.parse(h.heartbeatAt) || 0) <= ttlMs);
}

/**
 * The strict helm rule: once a lobsterman has signed on, the orchestrator
 * verbs that consume helm state are theirs alone. Returns the refusal
 * message for an unidentified or foreign caller, or undefined when the call
 * is allowed (no live helm anywhere, or the caller is one).
 */
export function helmGate(live: HelmRegistration[], sessionId?: string): string | undefined {
  if (live.length === 0) return undefined; // no claimed lobsterman — open water
  if (sessionId !== undefined && live.some((h) => h.sessionId === sessionId)) return undefined;
  const holders = live.map((h) => `${h.grounds}=${h.sessionId.slice(0, 8)}`).join(', ');
  return (
    `the helm is claimed (${holders}) — this verb is reserved for the helm session. ` +
    'Run it there with --session <helm-session-id>, or take the helm (`lobstah man helm --take`).'
  );
}

export type TakeHelmResult = { ok: HelmRegistration } | { held: HelmRegistration };

/**
 * Take the helm for one grounds. A foreign holder with a fresh heartbeat
 * refuses unless `take` is explicit; a stale holder (past ttl) is claimable
 * outright. A displaced holder gets a relieved notice either way — a resumed
 * ghost session deserves to learn it lost the helm.
 */
export function takeHelm(opts: {
  sessionId: string;
  grounds: Grounds;
  ttlMs: number;
  take?: boolean;
  now?: number;
}): TakeHelmResult {
  const now = opts.now ?? Date.now();
  const existing = readHelm(opts.grounds.name);
  if (existing && existing.sessionId !== opts.sessionId) {
    const fresh = now - (Date.parse(existing.heartbeatAt) || 0) <= opts.ttlMs;
    if (fresh && !opts.take) return { held: existing };
    atomicWrite(
      path.join(relievedDir(), `${existing.sessionId}.json`),
      JSON.stringify(
        {
          sessionId: existing.sessionId,
          grounds: opts.grounds.name,
          by: opts.sessionId,
          at: new Date(now).toISOString(),
        } satisfies RelievedNotice,
        null,
        2,
      ),
    );
  }
  const iso = new Date(now).toISOString();
  const reg: HelmRegistration = {
    sessionId: opts.sessionId,
    grounds: opts.grounds.name,
    repos: opts.grounds.repos,
    signedOnAt: existing?.sessionId === opts.sessionId ? existing.signedOnAt : iso,
    heartbeatAt: iso,
    tookFrom:
      existing && existing.sessionId !== opts.sessionId
        ? { sessionId: existing.sessionId, at: iso }
        : existing?.tookFrom,
  };
  atomicWrite(helmPath(opts.grounds.name), JSON.stringify(reg, null, 2));
  return { ok: reg };
}

/** Step down from every helm this session holds; returns the grounds names. */
export function relieveHelm(sessionId: string): string[] {
  const relieved: string[] = [];
  for (const h of listHelms()) {
    if (h.sessionId !== sessionId) continue;
    fs.rmSync(helmPath(h.grounds), { force: true });
    relieved.push(h.grounds);
  }
  // Stepping down voluntarily clears any stand-down notice left for us.
  fs.rmSync(path.join(relievedDir(), `${sessionId}.json`), { force: true });
  return relieved;
}

export function heartbeatHelm(sessionId: string): HelmRegistration | undefined {
  const reg = helmOf(sessionId);
  if (!reg) return undefined;
  const next = { ...reg, heartbeatAt: new Date().toISOString() };
  atomicWrite(helmPath(reg.grounds), JSON.stringify(next, null, 2));
  return next;
}

/** Read and remove this session's stand-down notice, if one waits. */
export function consumeRelievedNotice(sessionId: string): RelievedNotice | undefined {
  const file = path.join(relievedDir(), `${sessionId}.json`);
  try {
    const notice = JSON.parse(fs.readFileSync(file, 'utf8')) as RelievedNotice;
    fs.rmSync(file, { force: true });
    return notice;
  } catch {
    return undefined;
  }
}

/**
 * The configured grounds, or one implicit "fleet" grounds covering every
 * repo when none are configured — the partition only exists when asked for.
 */
export function groundsList(cfg: Config): Grounds[] {
  const entries = Object.entries(cfg.grounds);
  if (entries.length === 0) return [{ name: 'fleet', repos: Object.keys(cfg.repos) }];
  return entries.map(([name, g]) => ({ name, repos: g.repos }));
}

/** Config mistakes: a repo in two grounds, or a grounds naming an unknown repo. */
export function groundsErrors(cfg: Config): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const [name, g] of Object.entries(cfg.grounds)) {
    for (const repo of g.repos) {
      if (cfg.repos[repo] === undefined) errors.push(`grounds.${name} names unknown repo "${repo}"`);
      const other = seen.get(repo);
      if (other !== undefined) errors.push(`repo "${repo}" is in both grounds.${other} and grounds.${name} — a repo belongs to at most one grounds`);
      else seen.set(repo, name);
    }
  }
  return errors;
}

/** Resolve one grounds by name, or the only one when the name is omitted. */
export function resolveGrounds(cfg: Config, name?: string): Grounds {
  const all = groundsList(cfg);
  if (name === undefined) {
    if (all.length === 1) return all[0]!;
    throw new Error(`multiple grounds configured — pass --grounds <${all.map((g) => g.name).join('|')}>`);
  }
  const found = all.find((g) => g.name === name);
  if (!found) throw new Error(`unknown grounds "${name}" (configured: ${all.map((g) => g.name).join(', ')})`);
  return found;
}
