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
  /** Preserve every occurrence in order (for file attachments). */
  repeatable?: boolean;
}

export interface CommandSpec {
  flags: Record<string, FlagSpec>;
  /** Allowed first positional; bare invocation is always allowed too. */
  subverbs?: string[];
  /** Positional synopsis text, verbatim. */
  positionals?: string;
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
      '--attach': { value: '<file>', repeatable: true },
      '--for': { value: 'wt:<trap>' },
      '--session': { value: '<id>' },
      '--chore': {},
      '--id': { value: '<uuid>' },
    },
  },
  ls: { flags: { '--all': {} } },
  status: { flags: {}, positionals: '[<uuid>]' },
  logs: { flags: { '--follow': {}, '--full': {} }, positionals: '<uuid>' },
  send: { flags: { '--session': { value: '<id>' }, '--attach': { value: '<file>', repeatable: true } }, positionals: '<uuid>|wt:<trap> [<message...>]' },
  inbox: { flags: {}, positionals: '<uuid>' },
  attach: { flags: { '--print': {}, '--force': {} }, positionals: '<uuid>' },
  swap: {
    flags: {
      '--harness': { value: HARNESS },
      '--model': { value: '<m>' },
      '--effort': { value: '<e>' },
      '--session': { value: '<id>' },
    },
    positionals: '<uuid>',
  },
  catch: { flags: {}, positionals: '<uuid>' },
  prs: { subverbs: ['sync'], flags: {} },
  attention: { subverbs: ['ack', 'unack', 'ls'], flags: { '--by': { value: '<label>' } }, positionals: '[<item-key>]' },
  cull: { flags: { '--older-than': { value: '<days>' }, '--apply': {} } },
  cancel: { flags: { '--session': { value: '<id>' } }, positionals: '<uuid>' },
  report: { flags: { '--pr': { value: '<url>' }, '--no-watch': {} }, positionals: '<uuid> <verb> [note...]' },
  watch: {
    subverbs: ['add', 'rm', 'ls', 'check-pr'],
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
  soak: {
    flags: {
      '--session': { value: '<id>' },
      '--one': {},
      '--harness': { value: HARNESS },
      '--wait': {},
      '--timeout': { value: '<secs>' },
    },
  },
  stow: { flags: { '--session': { value: '<id>' }, '--wt': { value: '<trap>' }, '--quiet': {} } },
  daemon: { subverbs: ['install', 'uninstall'], flags: { '--interval': { value: '<ms>' } } },
  pick: { subverbs: ['once', 'install', 'uninstall'], flags: {} },
  doctor: { flags: {} },
  glass: { flags: { '--port': { value: '<n>' } } },
  pet: { subverbs: ['install', 'uninstall'], flags: { '--binary': { value: '<path>' } } },
  repos: { subverbs: ['add'], flags: { '--pickup': {}, '--key': { value: '<k>' } }, positionals: '[<path>]' },
  init: { flags: { '--scan': {}, '--pickup': {} }, positionals: '[<dir>...]' },
  version: { flags: {} },
  'man:manual': { flags: {} },
  'man:tend': { flags: { '--json': {} } },
  'man:report': {
    flags: {
      '--grounds': { value: '<name>' },
      '--cursor': { value: '<name>' },
      '--peek': {},
      '--json': {},
      '--session': { value: '<id>' },
    },
  },
  'man:wait': {
    flags: {
      '--timeout': { value: '<secs>' },
      '--peek': {},
      '--grounds': { value: '<name>' },
      '--session': { value: '<id>' },
    },
  },
  'man:helm': {
    flags: { '--session': { value: '<id>' }, '--grounds': { value: '<name>' }, '--label': { value: '<name>' }, '--take': {}, '--harness': { value: HARNESS } },
  },
  'man:relieve': { flags: { '--session': { value: '<id>' } } },
  'man:init': { flags: { '--shared': {}, '--global': {}, '--marker': {} } },
  'man:haul': { flags: { '--timeout': { value: '<secs>' }, '--park': {} } },
  'man:brief': { flags: {} },
  __runner: { flags: {}, positionals: '<active-dir> [work|chore]' },
};

/** Hand-written prose under each generated synopsis. */
export const PROSE: Record<string, string> = {
  dispatch: `Queue supervised work; prints id. --for wt:<trap> targets a signed-on trap
(sticky; session:<id> resolves to it). A claimed helm requires --session
<helm-id> to address work. Repeat --attach to copy files into owned state.
Alias: set --bait.`,
  ls: `Queue, active, and recent done dispatches (--all includes chores). Alias: buoys.`,
  status: `Reconciled state for one dispatch, or all active without an id. Alias: buoy.`,
  logs: `The dispatch's normalized event stream — last 50 events by default,
--full for everything, --follow to tail.`,
  send: `Deliver an instruction: to a dispatch's inbox (<uuid>), or to the session
manning a worktree (wt:<trap> — delivered at its next park, no catch
lifecycle; undeliverable messages bounce to the helm). Messages carry their
sender. With a claimed helm, sending requires --session <helm-id>. Flags go
anywhere; repeat --attach to copy files with the message. After \`--\` every
word is message text, even "--session".`,
  inbox: `Read and acknowledge pending messages (workers: check at natural checkpoints).`,
  attach: `Open the dispatch's own harness session in its worktree. Refused while
working unless --force; --print shows the command instead of running it.`,
  swap: `Hand an active dispatch to a fresh session — same worktree and brief plus a
git progress note.`,
  catch: `The evidence: branch, commits, PR, session.`,
  prs: `List known PR records newest first with state, checks, age, and watch state.
\`prs sync\` registers missing PR watches and refreshes each due PR once.`,
  attention: `Standing attention items with their ack state; \`ack <item-key>\` marks the
current state seen (--by names who), \`unack\` clears it. Display-only: an ack
hides the item from the desktop pet and the glass lobs until its state
changes — never from man tend --json, man wait, the park, or reminders.
Item keys: <lane>:<uuid> (question, landed), pr:<owner>/<repo>#<n> (pr:*),
watch:<key>. An unknown key exits 2.`,
  cull: `Sweep aged done entries, orphaned worktrees, and stale state. Dry run
without --apply (default 14 days).`,
  cancel: `Request cancellation. Claimed work winds down at the claimant's next check;
unclaimed queue items finalize immediately with an audit record. With a
claimed helm this requires --session <helm-id>.`,
  report: `The validated status write path: working | needs-decision | blocked |
paused | done | failed. --pr goes anywhere; after \`--\` every word is note.
\`done --pr <github PR url>\` also registers the PR's pr: watch, owned by this
dispatch (idempotent; --no-watch opts out).`,
  watch: `Stand watch on something external; bare \`watch\` (or \`watch ls\`) lists.
The check command answers "anything since {cursor}?" in JSON.
\`watch add pr:<owner>/<repo>#<n>\` (or a PR URL) with no --check installs the
shipped PR check (\`watch check-pr\`, one \`gh pr view\` per cycle). With --for,
failing checks fork a CI-fix continuation (pick only) and the dispatch's
evidence carries a \`pr\` state object.`,
  soak: `Volunteer this session as a worker. Identity is the worktree: sign-on
anchors a trap id (.lobstah-trap) and prints its wt:<trap> address; re-runs
here need no flags (--session only on first sign-on). Refused from a
primary checkout. --one signs off after the first completed assignment.
--wait listens in the foreground right now (for sessions without Stop
hooks): work prints plain, a quiet timeout exits 3 — run it again.`,
  stow: `Sign the worktree's trap off (run it there, or pass --wt/--session); an
unfinished assignment requeues and unread messages bounce to the helm.
Stowing another session's trap is steering — with a claimed helm, only the
helm may (pass its --session). The trap's own worktree or session is always
free to stow itself.`,
  daemon: `The supervisor process (claims, worktrees, liveness, restarts). install
writes + loads a launchd agent / systemd user unit.`,
  pick: `Tracker loops: poll Linear/GitHub, dispatch assigned work, report back,
reconcile, merge.`,
  doctor: `Check binaries, config, repos, harnesses, and the daemon heartbeat; exit 1
on failures.`,
  pet: `The desktop pet (macOS): attention questions crawl across the screen as
the lobster, each with its question in a speech bubble; clicking one opens
the helm. install copies the built binary under ~/.lobstah/bin and writes a
login LaunchAgent (build it first: cd apps/pet && swift build -c release).
Quitting the pet sticks until next login; uninstall removes the agent.`,
  glass: `The spyglass: tend as a live localhost web page — attention, dispatches,
traps with lifecycle and mail, notices, merge view; filters and a
table/cards toggle. Read-only and binds 127.0.0.1 only: looking through it
consumes no cursor and steers nothing.`,
  repos: `List configured repos, or detect one and append its [repos.*] block.`,
  init: `Create ~/.lobstah + config; --scan appends a [repos.*] block per repo found
under the given directories.`,
  version: `The installed lobstah version.`,
  'man:manual': `The lobsterman's manual.`,
  'man:tend': `The whole-fleet pass: verdict, unanswered questions, each work item's chain,
PR, and merge gate. Pure disk read.`,
  'man:report': `The delta since the last report: landed, arisen, still-waiting, verdict.
Advances the cursor unless --peek — the acknowledgment man wait's timeout
digest defers to. --grounds scopes digest and cursor to one helm's territory
(that helm's alone). Reserved for the claimed helm; identify with --session
(defaults --grounds to its own).`,
  'man:helm': `Take the helm: sign this session on as the one lobsterman for its grounds.
Prints the charter, enables the Stop-hook arm check, and gates the digest.
Sign-on records who the man is (harness, directory, host; --label names it).
A live foreign holder refuses without --take; a stale one is claimable.
The session id resolves --session, then hook stdin, then
$CLAUDE_CODE_SESSION_ID — so inside Claude Code no flag is needed.`,
  'man:relieve': `Step down from the helm; a displaced predecessor's stand-down notice is
cleared too.`,
  'man:wait': `Block until a dispatch or watched source needs attention; exit 3 on timeout,
showing the man report delta (a peek) when something changed. --peek never
blocks: it shows standing events unconsumed, else \`standing: none\`, exit 0
(no --timeout). A claimed helm reserves this verb — identify with --session
(heartbeats the helm, defaults --grounds to its own).`,
  'man:init': `Install the haul Stop hook into Claude settings; --marker touches
.lobstah-man to arm this directory.`,
  'man:haul': `Stop-hook entry: on Claude Code, require a live background waiter while
work is in flight; standing attention blocks immediately. --park or
[helm].park = "block" restores the blocking hook for other hosts. Hookless
sessions use foreground \`soak --wait\` or \`man wait\`.`,
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

/** A flag's parsed value: its value token, or `true` for a boolean flag. */
export type FlagValue = string | string[] | true;

export interface ParsedArgs {
  /** Registered flags found anywhere in argv; repeatable flags collect values. */
  flags: Map<string, FlagValue>;
  /** Everything that is not a flag or a flag's value, in order. */
  positionals: string[];
  help?: boolean;
  error?: string;
}

/**
 * The one flag-extraction step every verb goes through. A registered flag is
 * honored wherever it appears — before, between, or after the positionals —
 * and a value-flag consumes the next token unexamined. `--` ends flag
 * parsing: every later token is a positional, so message and note text can
 * still carry a literal flag. An unregistered `--flag` outside that tail is
 * a usage error (axi.md P6), never silently absorbed into prose; `--help`
 * before any `--` asks for the usage card. Returns undefined for a command
 * outside the registry.
 */
export function parseArgs(cmd: string, args: string[]): ParsedArgs | undefined {
  const spec = COMMANDS[cmd];
  if (!spec) return undefined;
  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];
  const fail = (error: string): ParsedArgs => ({ flags, positionals, error });
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!tok.startsWith('--')) {
      // Where subverbs exist, further positionals only ever follow one.
      if (positionals.length === 0 && spec.subverbs && !spec.subverbs.includes(tok)) {
        return fail(`unknown ${cmd} subcommand "${tok}" (expected ${spec.subverbs.join(' | ')})`);
      }
      positionals.push(tok);
      continue;
    }
    if (tok === '--help') return { flags, positionals, help: true };
    const f = spec.flags[tok];
    if (!f) return fail(`unknown flag ${tok} for ${cmd.replace(':', ' ')}`);
    let value: FlagValue = true;
    if (f.value) {
      if (i + 1 >= args.length) return fail(`flag ${tok} needs a value (${tok} ${f.value})`);
      value = args[++i]!; // the value is consumed, never validated
    }
    if (f.repeatable) {
      const previous = flags.get(tok);
      flags.set(tok, [...(Array.isArray(previous) ? previous : []), value as string]);
    } else if (!flags.has(tok)) {
      flags.set(tok, value);
    }
  }
  return { flags, positionals };
}
