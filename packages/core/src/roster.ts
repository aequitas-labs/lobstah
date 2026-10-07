import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from './paths.js';
import type { TrapRegistration } from './soak.js';
import type { WindowRef } from './window.js';
import type { TrapRevision } from './worktree-safety.js';
import { trapIdForName } from './trap-names.js';

/**
 * The trap roster: one durable record per trap that ever signed on, kept in
 * `~/.lobstah/roster/<trapId>.json`. A registration (`soaking/`) lives only
 * while a session mans the trap, and the signed-off hold only for the mail
 * grace; the roster record stays through stow, a ghost sweep, and `cull`.
 * It is the source of truth for a trap's name and identity, and it holds
 * what a later `man throw` needs to bring the trap back: repository,
 * checkout, revision, harness, and session.
 *
 * A roster record never makes a trap live or claimable: delivery and
 * claims read registrations only.
 */
export const ROSTER_VERSION = 1;

/** Terminal apps a thrown trap can open in. */
export const TERMINAL_APPS = ['terminal', 'iterm'] as const;
export type TerminalApp = (typeof TERMINAL_APPS)[number];

/**
 * A trap's saved configuration: how a throw should start it. Set with
 * `man roster set`; each field overrides what the trap last signed on with.
 * PR 1 stores and prints it; a throw applies it.
 */
export interface TrapProfile {
  harness?: string;
  model?: string;
  /** Harness settings beyond the model (`effort`, …), by name. */
  config?: Record<string, string>;
  /** The terminal app for this trap; overrides `[soak].terminal`. */
  terminal?: TerminalApp;
}

export type RosterState = 'live' | 'stowed' | 'ghosted';

export interface RosterEntry {
  version: typeof ROSTER_VERSION;
  trapId: string;
  /** The trap's canonical name. A returning trap signs on under it. */
  name: string;
  /** Config repo key. */
  repo?: string;
  /** Canonical git common directory of the repo, when the worktree was a checkout. */
  gitDir?: string;
  /** Worktree root the trap is anchored to. */
  worktree: string;
  /** True when `lobstah soak` created the worktree. */
  createdWorktree?: boolean;
  /** The branch soak created with the worktree. */
  soakBranch?: string;
  /** The last revision lobstah saw, and the protected ref that keeps it. */
  branch?: string;
  head?: string;
  ref?: string;
  revisionAt?: string;
  /** What the trap last signed on with: the harness, its session, and the registration's model and config. */
  harness: string;
  sessionId: string;
  model?: string;
  config?: Record<string, string>;
  /** Navigation hints from the last sign-on. Never liveness evidence. */
  window?: WindowRef;
  link?: string;
  firstSignedOnAt: string;
  signedOnAt: string;
  state: RosterState;
  /** When and why the trap left (stow or ghost sweep). */
  leftAt?: string;
  leftReason?: string;
  /** The dispatch the trap held when it left. */
  lastCatch?: string;
  /** The saved configuration a throw applies. */
  profile?: TrapProfile;
  /** Set by a deliberate forget: a throw skips the trap. */
  forgottenAt?: string;
  updatedAt: string;
}

/**
 * The model and config a registration records (`model`, and `config` as
 * `{ effort, permissionMode }`, refreshed by hook observations). Read by
 * name, not imported: an unknown value is a null, and nulls are dropped.
 */
type RegistrationExtras = { model?: unknown; config?: unknown };

function observed(reg: TrapRegistration): Pick<RosterEntry, 'model' | 'config'> {
  const extras = reg as TrapRegistration & RegistrationExtras;
  return {
    model: typeof extras.model === 'string' && extras.model ? extras.model : undefined,
    config: stringMap(extras.config),
  };
}

function rosterDir(): string {
  return path.join(lobstahHome(), 'roster');
}

function rosterPath(trapId: string): string {
  return path.join(rosterDir(), `${trapId}.json`);
}

function writeEntry(entry: RosterEntry): RosterEntry {
  fs.mkdirSync(rosterDir(), { recursive: true });
  const file = rosterPath(entry.trapId);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return entry;
}

export function readRoster(trapId: string): RosterEntry | undefined {
  if (!/^[a-z0-9-]+$/.test(trapId)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(rosterPath(trapId), 'utf8')) as RosterEntry;
    return parsed.trapId === trapId && typeof parsed.name === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every roster record, by name. */
export function listRoster(): RosterEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(rosterDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => readRoster(f.slice(0, -'.json'.length)))
    .filter((e): e is RosterEntry => e !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a bare name, wt:name, bare id, or wt:id to a roster record. */
export function rosterByAddress(address: string): RosterEntry | undefined {
  const value = address.startsWith('wt:') ? address.slice(3) : address;
  if (!/^[a-z0-9-]+$/.test(value)) return undefined;
  return readRoster(trapIdForName(value) ?? value) ?? listRoster().find((e) => e.name === value);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined && v !== null && typeof v !== 'object') out[k] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function withRevision(entry: RosterEntry, revision: TrapRevision | undefined): RosterEntry {
  if (!revision) return entry;
  return {
    ...entry,
    gitDir: revision.gitDir,
    head: revision.head,
    ref: revision.ref,
    revisionAt: revision.at,
    ...(revision.branch ? { branch: revision.branch } : {}),
  };
}

/**
 * Record a sign-on: the registration's identity, harness, session, and
 * window, and the checkout's revision. A forget is lifted (the trap came
 * back); the saved profile and first sign-on time stay.
 */
export function recordRosterSignOn(
  reg: TrapRegistration,
  opts: { soakBranch?: string; revision?: TrapRevision; now?: number } = {},
): RosterEntry {
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const prior = readRoster(reg.trapId);
  const seen = observed(reg);
  const { forgottenAt: _forgotten, leftAt: _left, leftReason: _reason, ...kept } = prior ?? ({} as Partial<RosterEntry>);
  const entry: RosterEntry = {
    ...kept,
    version: ROSTER_VERSION,
    trapId: reg.trapId,
    name: reg.name ?? prior?.name ?? `wt:${reg.trapId}`,
    worktree: reg.worktree,
    harness: reg.harness,
    sessionId: reg.sessionId,
    firstSignedOnAt: prior?.firstSignedOnAt ?? reg.signedOnAt,
    signedOnAt: reg.signedOnAt,
    state: 'live',
    updatedAt: at,
  };
  setOrDrop(entry, 'repo', reg.repo);
  setOrDrop(entry, 'createdWorktree', reg.createdWorktree || undefined);
  setOrDrop(entry, 'window', reg.window);
  setOrDrop(entry, 'link', reg.link);
  setOrDrop(entry, 'model', seen.model);
  setOrDrop(entry, 'config', seen.config);
  if (opts.soakBranch ?? prior?.soakBranch) entry.soakBranch = opts.soakBranch ?? prior?.soakBranch;
  return writeEntry(withRevision(entry, opts.revision));
}

function setOrDrop<K extends keyof RosterEntry>(entry: RosterEntry, key: K, value: RosterEntry[K] | undefined): void {
  if (value === undefined) delete entry[key];
  else entry[key] = value;
}

/**
 * Record that a trap left: stowed or ghosted, why, the catch it held, and
 * its last revision. Written before the registration and the checkout go,
 * so nothing a later throw needs is lost with them.
 */
export function recordRosterDeparture(
  reg: TrapRegistration,
  state: Exclude<RosterState, 'live'>,
  reason: string,
  opts: { revision?: TrapRevision; now?: number } = {},
): RosterEntry {
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const base = readRoster(reg.trapId) ?? recordRosterSignOn(reg, { now: opts.now });
  const entry: RosterEntry = {
    ...base,
    // A session that adopted the trap since the last record is the one that left.
    harness: reg.harness,
    sessionId: reg.sessionId,
    state,
    leftAt: at,
    leftReason: reason,
    updatedAt: at,
  };
  setOrDrop(entry, 'lastCatch', reg.claimed ?? base.lastCatch);
  // Observations made after sign-on (the model a hook reported) are the latest.
  const seen = observed(reg);
  if (seen.model) entry.model = seen.model;
  if (seen.config) entry.config = seen.config;
  return writeEntry(withRevision(entry, opts.revision));
}

/** Record a revision kept under the protected ref (a cull or a stow removing the checkout). */
export function recordRosterRevision(trapId: string, revision: TrapRevision | undefined, now = Date.now()): RosterEntry | undefined {
  const entry = readRoster(trapId);
  if (!entry || !revision) return entry;
  return writeEntry(withRevision({ ...entry, updatedAt: new Date(now).toISOString() }, revision));
}

/** The profile keys `man roster set` accepts. */
export type ProfilePatch = {
  harness?: string | null;
  model?: string | null;
  terminal?: TerminalApp | null;
  /** Set (string) or clear (null) one config key each. */
  config?: Record<string, string | null>;
};

/** Change a trap's saved profile. null clears a field. Returns the updated record. */
export function setRosterProfile(trapId: string, patch: ProfilePatch, now = Date.now()): RosterEntry | undefined {
  const entry = readRoster(trapId);
  if (!entry) return undefined;
  const profile: TrapProfile = { ...entry.profile };
  for (const key of ['harness', 'model', 'terminal'] as const) {
    const value = patch[key];
    if (value === null) delete profile[key];
    else if (value !== undefined) (profile as Record<string, string>)[key] = value;
  }
  if (patch.config) {
    const config = { ...profile.config };
    for (const [k, v] of Object.entries(patch.config)) {
      if (v === null) delete config[k];
      else config[k] = v;
    }
    if (Object.keys(config).length) profile.config = config;
    else delete profile.config;
  }
  const next: RosterEntry = { ...entry, updatedAt: new Date(now).toISOString() };
  if (Object.keys(profile).length) next.profile = profile;
  else delete next.profile;
  return writeEntry(next);
}

/** Whether a value names a terminal app (`terminal`, `iterm`). */
export function isTerminalApp(value: unknown): value is TerminalApp {
  return typeof value === 'string' && (TERMINAL_APPS as readonly string[]).includes(value);
}

/** The display name of a terminal app. */
export function terminalAppName(app: TerminalApp): string {
  return app === 'iterm' ? 'iTerm2' : 'Terminal.app';
}
