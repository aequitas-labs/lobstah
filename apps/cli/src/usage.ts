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
  /** Flags that are meaningful only with one of these first positionals. */
  flagSubverbs?: Record<string, string[]>;
  /** Allowed first positional; bare invocation is always allowed too. */
  subverbs?: string[];
  /** Positional synopsis text, verbatim. */
  positionals?: string;
  /** Reject extra positionals for commands with no positional forms. */
  maxPositionals?: number;
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
      '--for': { value: '<name>|wt:<trap>' },
      '--session': { value: '<id>' },
      '--chore': {},
      '--id': { value: '<uuid>' },
    },
  },
  ls: { flags: { '--all': {} } },
  status: { flags: {}, positionals: '[<uuid>|<trap-name>|wt:<trap>]' },
  stats: { flags: { '--json': {}, '--per-trap': {} }, maxPositionals: 0 },
  focus: { flags: {}, positionals: '<trap>' },
  logs: { flags: { '--follow': {}, '--full': {} }, positionals: '<uuid>' },
  send: { flags: { '--session': { value: '<id>' }, '--attach': { value: '<file>', repeatable: true }, '--no-reply': {} }, positionals: '<uuid>|<trap-name>|wt:<trap> [<message...>]' },
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
  prs: { flags: {}, maxPositionals: 0 },
  reports: { flags: { '--json': {} } },
  attention: { subverbs: ['ack', 'unack', 'ls'], flags: { '--by': { value: '<label>' }, '--json': {} }, positionals: '[<item-key>]' },
  cull: { flags: { '--older-than': { value: '<days>' }, '--apply': {} } },
  cancel: { flags: { '--session': { value: '<id>' } }, positionals: '<uuid>' },
  report: {
    flags: {
      '--pr': { value: '<url>', repeatable: true },
      '--no-watch': {},
      '--waiting-on': { value: 'review|pr|deploy|person|external' },
      '--link': { value: '<url>' },
      '--until': { value: '<iso|30m|4h|2d>' },
      '--human-gate': { value: '<check>', repeatable: true },
      '--report': { value: '<file.md>' },
      '--attach': { value: '<file>', repeatable: true },
      '--session': { value: '<id>' },
    },
    positionals: '<uuid> <verb> [note...]',
  },
  watch: {
    subverbs: ['add', 'rm', 'ls', 'check-pr', 'backfill', 'hold', 'release'],
    flags: {
      '--check': { value: '<cmd>' },
      '--for': { value: '<uuid>' },
      '--cursor': { value: '<c>' },
      '--every': { value: '<s>' },
      '--brief': { value: '<template>' },
      '--stream': { value: '<cmd>' },
      '--apply': {},
      '--all': {},
    },
    flagSubverbs: { '--apply': ['backfill'], '--all': ['release'] },
    positionals: '[<key>]',
  },
  soak: {
    subverbs: ['beat', 'title-set'],
    flags: {
      '--session': { value: '<id>' },
      '--one': {},
      '--harness': { value: HARNESS },
      '--wait': {},
      '--timeout': { value: '<secs>' },
      '--repo': { value: '<key>' },
      '--link': { value: '<url>' },
      '--name': { value: '<word-word>' },
      '--ticket': { value: '<ticket>' },
    },
  },
  trap: {
    subverbs: ['reserve', 'requests', 'title-set'],
    flags: {
      '--repo': { value: '<key>' },
      '--request': { value: '<id>' },
      '--harness': { value: HARNESS },
      '--name': { value: '<word-word>' },
      '--deadline': { value: '<secs>' },
      '--session': { value: '<id>' },
    },
    flagSubverbs: {
      '--repo': ['reserve'],
      '--request': ['reserve'],
      '--harness': ['reserve'],
      '--name': ['reserve'],
      '--deadline': ['reserve'],
      '--session': ['reserve', 'title-set'],
    },
  },
  stow: { flags: { '--session': { value: '<id>' }, '--wt': { value: '<trap>' }, '--keep': {}, '--force': {}, '--quiet': {} } },
  daemon: { subverbs: ['install', 'uninstall', 'restart', 'status'], flags: { '--interval': { value: '<ms>' }, '--force': {} }, flagSubverbs: { '--force': ['restart'] } },
  pick: { subverbs: ['once', 'install', 'uninstall', 'restart'], flags: {} },
  doctor: { flags: {} },
  glass: { subverbs: ['stop', 'status', 'install', 'uninstall', 'restart'], flags: { '--port': { value: '<n>' }, '--detach': {} } },
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
  hook: { flags: {}, subverbs: ['session-start', 'stop', 'post-tool-use', 'session-end'], maxPositionals: 1 },
  'man:file': {
    flags: { '--attach': { value: '<file>', repeatable: true }, '--title': { value: '<text>' }, '--grounds': { value: '<name>' }, '--session': { value: '<id>' } },
    positionals: '<file.md>',
  },
  'man:ask': {
    flags: {
      '--title': { value: '<question>' },
      '--detail': { value: '<file.md>' },
      '--option': { value: '<label>', repeatable: true },
      '--attach': { value: '<file>', repeatable: true },
      '--withdraw': { value: '<key>' },
      '--replace': { value: '<key>' },
      '--grounds': { value: '<name>' },
      '--session': { value: '<id>' },
    },
    positionals: '[<dispatch-id>]',
  },
  'man:answer': {
    flags: { '--option': { value: '<label>' }, '--text': { value: '<text>' }, '--attach': { value: '<file>', repeatable: true } },
    positionals: '<key>',
  },
  __runner: { flags: {}, positionals: '<active-dir> [work|chore]' },
};

/** Hand-written prose under each generated synopsis. */
export const PROSE: Record<string, string> = {
  dispatch: `Queue supervised work; prints id. --for <name>, wt:<name>, or wt:<id> targets a signed-on trap
(sticky; session:<id> resolves to it). A claimed helm requires --session
<helm-id> to address work. Repeat --attach to copy files into owned state.
Alias: set --bait.`,
  ls: `Queue, active, and recent done dispatches (--all includes chores). Alias: buoys.`,
  status: `Reconciled state for one dispatch, or all active without an id. A trap name,
wt:<name>, or wt:<id> shows its live registration. Alias: buoy.`,
  focus: `Bring a live trap's recorded session or window forward on this machine.
Accepts its name or id with or without wt:. Reports the focus step, or why it could
not focus. A session link can open on any supported platform; native window
focus requires macOS.`,
  logs: `The dispatch's normalized event stream — last 50 events by default,
--full for everything, --follow to tail.`,
  send: `Steer a live chain, queue for pending work, or wake a finished chain
as a follow-up; the worker's next note wakes man wait (--no-reply: none). To
choose the follow-up's worker, harness, or model, use dispatch --follow-up with
--for, --harness, or --model. --attach copies files. A claimed helm requires
--session <helm-id>. Trap-name messages arrive at its next park.`,
  inbox: `Read and acknowledge pending messages (workers: check at natural checkpoints).`,
  attach: `Open the dispatch's own harness session in its worktree. Refused while
working unless --force; --print shows the command instead of running it.`,
  swap: `Hand an active dispatch to a fresh session — same worktree and brief plus a
git progress note.`,
  catch: `The evidence: branch, commits, PR, session, and the worktree it ran in.`,
  prs: `List known PR records newest first with state, checks, age, and watch state.
Use watch check-pr <key> to force a refresh of one PR watch.`,
  attention: `Standing attention items with their ack state; \`ack <item-key>\` marks the
current state seen (--by names who), \`unack\` clears it. Display-only: an ack
hides the item from the desktop pet and the glass lobs until its state
changes — never from man tend --json, man wait, the park, or reminders.
Item keys: <lane>:<uuid> (question, landed), pr:<owner>/<repo>#<n> (pr:*),
watch:<key>, report:<lane>:<uuid> or report:helm:<grounds>:<rid> (report). An unknown key exits 2. --json prints { "attention": [...] },
the same items and fields as man tend --json (the desktop pet reads it), less questions held on the helm's turn (the held column).`,
  cull: `Sweep aged done entries, orphaned worktrees, and stale state. Dry run
without --apply (default 14 days): it measures each target (one du per
worktree). --apply measures nothing; it deletes and prints the count and the
free-space change. The daemon culls on its own with [limits].retentionDays, and
frees a merged PR's clean, pushed worktree with [limits].releaseOnMerge.`,
  cancel: `Request cancellation. Claimed work winds down at the claimant's next check;
unclaimed queue items finalize immediately with an audit record. With a
claimed helm this requires --session <helm-id>.`,
  report: `Status write path: working | needs-decision | blocked | paused | done | failed. After \`--\` all is note.
\`--pr <url>\` on any verb but failed records the PR and, like \`paused --waiting-on pr|review\`, registers its watch (--no-watch opts out).
--waiting-on, --link, --until: what a pause waits on, and when it ends. --human-gate <check>: repairs skip a check only a person passes.
A trap's done records its HEAD (--session). done|failed --report <file.md> files a findings page as the report; --attach adds the images it names.`,
  stats: `Catches: dispatches that finished done. catchesToday counts the local day;
totalCatches counts all time. Both live in stats.json, which cull folds into
before deleting, so they survive it. --per-trap adds each trap's total under
its persistent name. TOON by default; --json for the same fields. Nothing is sent.`,
  reports: `Every filed report, newest first: key, title, author (trap name, headless,
or helm), the dispatch or helm grounds, when it was filed, and whether it is
acked. \`lobstah attention ack <key>\` acks one.`,
  watch: `Stand watch on something external; bare \`watch\` lists. \`watch add pr:<o>/<r>#<n>\`
installs the shipped PR check; with --for, a check that fails after the first
(baseline) check forks a CI-fix continuation (pick only). Only \`watch add\`,
\`report --pr\`, a trap's beat, and \`watch backfill --apply\` register; reads never do.
\`watch hold <key> [--for <id>]\` holds PR repairs (--for ends it); \`watch release <key>|--all\` frees holds/cap.`,
  soak: `Volunteer as worker (name + wt:<trap>); linked worktrees sign on there.
Primary checkout or --repo creates worktrees/soak-<trap> from trunk: cd there.
Sessions reuse traps. --one stows after a catch; --name, --link set name, URL.
--wait listens (quiet exit 3: re-run). --ticket or LOBSTAH_TRAP_TICKET signs
on as a reserved trap. Names the Terminal.app/iTerm2 tab. \`soak beat\`: hook.`,
  trap: `\`trap reserve\` reserves a trap before its session starts: name, id, ticket,
start command. dispatch --for works at once; soak --ticket <t> redeems it. Past
--deadline (default 180s) trap-start-failed posts; work stays queued. stow --wt
<name> withdraws it. --request <id> reserves what a glass request asks for and
closes it; \`trap requests\` lists them. \`trap title-set\` = \`soak title-set\`.`,
  stow: `Sign off (worktree or --wt/--session): unfinished catches requeue; done/failed
finalizes; unread messages bounce. Removes only worktrees soak created, kept
when dirty, untracked, unpushed to upstream, or without upstream (with reason).
--force discards unsaved files; --keep keeps it. --wt withdraws reservations.
Only a claimed helm may stow another session (pass its --session).
Clears the tab name sign-on set.`,
  daemon: `The supervisor process (claims, worktrees, liveness, restarts). install
writes + loads a launchd agent / systemd user unit; restart restarts it and
waits for the new heartbeat (refused while dispatches are active, unless
--force); status shows installed, running, pid, version, heartbeat age.`,
  pick: `Tracker loops: poll Linear/GitHub, dispatch assigned work, report back,
reconcile, merge. install, uninstall, and restart manage its user service.`,
  doctor: `Check binaries, config, repos, harnesses, the daemon heartbeat, and the
desktop pet (installed, running, whether its last read worked); exit 1 on
failures.`,
  pet: `The desktop pet (macOS): attention questions crawl across the screen as
the lobster, each with its question in a speech bubble; clicking one opens
the helm. install copies the built binary under ~/.lobstah/bin and writes a
login LaunchAgent (build it first: cd apps/pet && swift build -c release).
Quitting the pet sticks until next login; uninstall removes the agent.`,
  glass: `The spyglass: tend as a live localhost web page — attention, dispatches,
traps with lifecycle and mail, notices, merge view; filters and a
table/cards toggle. Read-only and binds 127.0.0.1 only: looking through it
consumes no cursor and steers nothing. --detach starts it in the background;
stop and status manage that process. install and uninstall manage a user service.
restart restarts the service, or a detached glass (stop, then --detach).`,
  repos: `List configured repos, or detect one and append its [repos.*] block.`,
  init: `Create ~/.lobstah + config; --scan appends a [repos.*] block per repo found
under the given directories.`,
  version: `The installed lobstah version.`,
  'man:manual': `The lobstah man's manual.`,
  'man:tend': `The whole-fleet pass: verdict, unanswered questions, each work item's chain,
PR, and merge gate. Pure disk read.`,
  'man:report': `The delta since the last report: landed, arisen, still-waiting, verdict.
Advances the cursor unless --peek — the acknowledgment man wait's timeout
digest defers to. --grounds scopes digest and cursor to one helm's territory
(that helm's alone). Reserved for the claimed helm; identify with --session
(defaults --grounds to its own).`,
  'man:helm': `Take the helm: sign this session on as the one lobstah man for its grounds.
Prints the charter, enables the Stop hook, and gates the digest.
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
  'man:haul': `Stop-hook entry: standing attention blocks immediately. In arm mode,
work in flight requires a live watcher or the hook blocks with the arm command.
--park or [helm].park = "block" waits in the hook instead.`,
  'man:file': `File a markdown page as the helm's own report, under its grounds (reports/<grounds>/<rid>/).
--attach copies images the page names by bare filename; --title overrides its first # heading.
The glass shows it on the deck; \`lobstah attention ack <key>\` acks it.`,
  'man:ask': `Put a decision to the human: a card in the glass (decisions/<rid>/) until
answered or withdrawn. Asks stand side by side; --replace <key> replaces one. The answer
wakes man wait as decision-answer. Reserved for the claimed helm.`,
  'man:answer': `Answer a decision (or a raw question's <lane>:<id>) as the glass does.
Stores the answer; the helm's man wait receives it as decision-answer.`,
  'man:brief': `SessionStart-hook entry point: announce the session id and fleet state into
the conversation.`,
  hook: `The plugin hook entry points. Each detects the session's role (helm, trap, or
neither): session-start runs man brief, stop runs man haul (--park, --timeout),
post-tool-use runs soak beat, session-end runs stow --quiet. The older commands
stay as aliases.`,
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
  for (const [flag, allowed] of Object.entries(spec.flagSubverbs ?? {})) {
    if (flags.has(flag) && !allowed.includes(positionals[0] ?? '')) {
      return fail(`flag ${flag} requires ${cmd.replace(':', ' ')} ${allowed.join(' | ')}`);
    }
  }
  if (spec.maxPositionals !== undefined && positionals.length > spec.maxPositionals) {
    return fail(`${cmd.replace(':', ' ')} takes no positional arguments`);
  }
  return { flags, positionals };
}
