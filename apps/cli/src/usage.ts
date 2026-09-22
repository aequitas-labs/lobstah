/**
 * The per-command registry: which flags and subverbs each command accepts.
 * One source drives both validation (axi.md P6 — unknown flags and subverbs
 * fail loudly, exit 2) and the generated synopsis line of every `--help`
 * card (P10); the prose below the synopsis stays hand-written, so the two
 * can never disagree about what actually parses.
 */

interface FlagSpec {
  /** Value placeholder for the synopsis; absent means a boolean flag. */
  value?: string;
  /** Required flags print without brackets. */
  required?: boolean;
}

export interface CommandSpec {
  flags: Record<string, FlagSpec>;
  /** Allowed first positional; bare invocation is always allowed too. */
  subverbs?: string[];
  /** Positional synopsis text, verbatim. */
  positionals?: string;
  /** Flag validation stops after this many positionals — the rest is prose. */
  tailAfter?: number;
}

const HARNESS = 'claude|codex';

export const COMMANDS: Record<string, CommandSpec> = {
  dispatch: {
    flags: {
      '--repo': { value: '<key>', required: true },
      '--brief': { value: '<file>' },
      '--bait': { value: '<file>' },
      '--brief-text': { value: '<text>' },
      '--harness': { value: HARNESS },
      '--model': { value: '<m>' },
      '--effort': { value: '<e>' },
      '--follow-up': { value: '<uuid>' },
      '--for': { value: 'session:<id>' },
      '--chore': {},
      '--id': { value: '<uuid>' },
    },
  },
  ls: { flags: { '--all': {} } },
  status: { flags: {}, positionals: '[<uuid>]' },
  logs: { flags: { '--follow': {}, '--full': {} }, positionals: '<uuid>' },
  send: { flags: {}, positionals: '<uuid> <message...>', tailAfter: 1 },
  inbox: { flags: {}, positionals: '<uuid>' },
  attach: { flags: { '--print': {}, '--force': {} }, positionals: '<uuid>' },
  swap: {
    flags: { '--harness': { value: HARNESS }, '--model': { value: '<m>' }, '--effort': { value: '<e>' } },
    positionals: '<uuid>',
  },
  catch: { flags: {}, positionals: '<uuid>' },
  cull: { flags: { '--older-than': { value: '<days>' }, '--apply': {} } },
  cancel: { flags: {}, positionals: '<uuid>' },
  report: { flags: {}, positionals: '<uuid> <verb> [note...] [--pr <url>]', tailAfter: 2 },
  watch: {
    subverbs: ['add', 'rm', 'ls'],
    flags: {
      '--check': { value: '<cmd>' },
      '--for': { value: '<uuid>' },
      '--cursor': { value: '<c>' },
      '--every': { value: '<s>' },
      '--brief': { value: '<template>' },
      '--stream': { value: '<cmd>' },
    },
    positionals: '[<key>]',
  },
  soak: { flags: { '--session': { value: '<id>', required: true }, '--one': {}, '--harness': { value: HARNESS } } },
  stow: { flags: { '--session': { value: '<id>' }, '--quiet': {} } },
  daemon: { subverbs: ['install', 'uninstall'], flags: { '--interval': { value: '<ms>' } } },
  pick: { subverbs: ['once', 'install', 'uninstall'], flags: {} },
  doctor: { flags: {} },
  repos: { subverbs: ['add'], flags: { '--pickup': {}, '--key': { value: '<k>' } }, positionals: '[<path>]' },
  init: { flags: { '--scan': {}, '--pickup': {} }, positionals: '[<dir>...]' },
  version: { flags: {} },
  'man:manual': { flags: {} },
  'man:tend': { flags: { '--json': {} } },
  'man:report': { flags: { '--cursor': { value: '<name>' }, '--peek': {}, '--json': {} } },
  'man:wait': { flags: { '--timeout': { value: '<secs>' }, '--peek': {} } },
  'man:init': { flags: { '--shared': {}, '--global': {}, '--marker': {} } },
  'man:haul': { flags: { '--timeout': { value: '<secs>' } } },
  'man:brief': { flags: {} },
  __runner: { flags: {}, positionals: '<active-dir> [work|chore]' },
};

/** Hand-written prose under each generated synopsis. */
export const PROSE: Record<string, string> = {
  dispatch: `Queue a supervised dispatch; prints the id. --for addresses the bait to a
soaking session instead of a fresh headless worker. Alias: set --bait.`,
  ls: `Queue, active, and recent done dispatches (--all includes chores). Alias: buoys.`,
  status: `Reconciled state for one dispatch, or all active without an id. Alias: buoy.`,
  logs: `The dispatch's normalized event stream — last 50 events by default,
--full for everything, --follow to tail.`,
  send: `Deliver an instruction to a running dispatch between its turns.`,
  inbox: `Read and acknowledge pending messages (workers: check at natural checkpoints).`,
  attach: `Open the dispatch's own harness session in its worktree. Refused while
working unless --force; --print shows the command instead of running it.`,
  swap: `Hand an active dispatch to a fresh session — same worktree and brief plus a
git progress note.`,
  catch: `The evidence: branch, commits, PR, session.`,
  cull: `Sweep aged done entries, orphaned worktrees, and stale state. Dry run
without --apply (default 14 days).`,
  cancel: `Request cancellation; the daemon (or the claiming session) winds it down.`,
  report: `The validated status write path: working | needs-decision | blocked |
paused | done | failed.`,
  watch: `Stand watch on something external; bare \`watch\` (or \`watch ls\`) lists.
The check command answers "anything since {cursor}?" in JSON.`,
  soak: `Volunteer this session as a worker: it parks at turn end and takes matching
bait. Refused from a primary checkout — soak from a worktree. --one stows
after the first catch.`,
  stow: `Sign a soaking session off; an open catch goes back to the queue.`,
  daemon: `The supervisor process (claims, worktrees, liveness, restarts). install
writes + loads a launchd agent / systemd user unit.`,
  pick: `Tracker loops: poll Linear/GitHub, dispatch assigned work, report back,
reconcile, merge.`,
  doctor: `Check binaries, config, repos, harnesses, and the daemon heartbeat; exit 1
on failures.`,
  repos: `List configured repos, or detect one and append its [repos.*] block.`,
  init: `Create ~/.lobstah + config; --scan appends a [repos.*] block per repo found
under the given directories.`,
  version: `The installed lobstah version.`,
  'man:manual': `The lobsterman's manual.`,
  'man:tend': `The whole-fleet pass: verdict, unanswered questions, each work item's chain,
PR, and merge gate. Pure disk read.`,
  'man:report': `The delta since the last report: catches landed, attention arisen, what still
waits, and the fleet verdict. Advances the "reported through" cursor unless
--peek; prints "no change" when the delta is empty.`,
  'man:wait': `Block until a dispatch or watched source needs attention; exit 3 on timeout.
A timeout carries the man report delta when something changed. --peek
surfaces standing events without consuming them.`,
  'man:init': `Install the haul Stop hook into Claude settings; --marker touches
.lobstah-man to arm this directory.`,
  'man:haul': `Stop-hook entry point: park the session while work is in flight (lobsterman
or soaking worker); prints hook-decision JSON on an event.`,
  'man:brief': `SessionStart-hook entry point: announce the session id and fleet state into
the conversation.`,
  __runner: `Internal: run one dispatch inside the compiled binary (the daemon re-execs
itself with this verb). Not for direct use.`,
};

/** Generated synopsis: command, subverbs, positionals, then flags. */
export function synopsis(cmd: string): string {
  const spec = COMMANDS[cmd];
  if (!spec) return `lobstah ${cmd.replace(':', ' ')}`;
  const parts = [`lobstah ${cmd.replace(':', ' ')}`];
  if (spec.subverbs) parts.push(`[${spec.subverbs.join('|')}]`);
  if (spec.positionals) parts.push(spec.positionals);
  for (const [flag, f] of Object.entries(spec.flags)) {
    const body = f.value ? `${flag} ${f.value}` : flag;
    parts.push(f.required ? body : `[${body}]`);
  }
  // Wrap at ~78 columns with a two-space continuation indent.
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const candidate = line === '' ? part : `${line} ${part}`;
    if (candidate.length > 78 && line !== '') {
      lines.push(line);
      line = `  ${part}`;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines.join('\n');
}

/** The full usage card: generated synopsis + hand-written prose. */
export function usageFor(cmd: string): string | undefined {
  if (!COMMANDS[cmd]) return undefined;
  const prose = PROSE[cmd];
  return prose ? `${synopsis(cmd)}\n${prose}` : synopsis(cmd);
}

/** A usage mistake — exits 2 (axi.md P6) instead of 1. */
export class UsageError extends Error {}

export interface Validation {
  help?: boolean;
  error?: string;
}

/**
 * Validate argv against the registry. Unknown flags and unknown subverbs are
 * errors; a value-flag consumes the next token unexamined; validation stops
 * at a command's free-text tail so a note or message may contain anything.
 * `--help` anywhere in the validated region asks for the usage card.
 */
export function validateArgs(cmd: string, args: string[]): Validation | undefined {
  const spec = COMMANDS[cmd];
  if (!spec) return undefined;
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (spec.tailAfter !== undefined && positionals >= spec.tailAfter) break;
    if (!tok.startsWith('--')) {
      // Where subverbs exist, further positionals only ever follow one.
      if (positionals === 0 && spec.subverbs && !spec.subverbs.includes(tok)) {
        return { error: `unknown ${cmd} subcommand "${tok}" (expected ${spec.subverbs.join(' | ')})` };
      }
      positionals++;
      continue;
    }
    if (tok === '--help') return { help: true };
    const f = spec.flags[tok];
    if (!f) return { error: `unknown flag ${tok} for ${cmd.replace(':', ' ')}` };
    if (f.value) i++; // the value is consumed, never validated
  }
  return {};
}
