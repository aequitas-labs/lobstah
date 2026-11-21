import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lobstahHome } from './paths.js';

/**
 * Run cards: a decision card that carries one script for the glass to run on
 * this Mac, as Chris's user, once he confirms it (ume 3ef69c1d-026).
 *
 * The helm posts one with `lobstah man ask --run <script>`. The CLI copies
 * the script into the card's directory (`decisions/<rid>/run/script`) and
 * records its SHA-256: that copy is what runs, and a copy that no longer
 * hashes to the card's value never runs. The card declares the inputs the
 * script reads on stdin, one line each, in order. Their values are typed on
 * the card and are never stored, logged, put on a command line or shown to
 * an agent. A trap proposes a script to the helm with
 * `lobstah report <id> needs-decision "…" --run <script>`; that is a
 * proposal, not a card.
 */

/** The largest script a card carries, so the card shows it whole. */
export const RUN_SCRIPT_MAX_BYTES = 16 * 1024;
/** A run's default time limit. */
export const RUN_TIMEOUT_DEFAULT_SECS = 5 * 60;
/** The longest time limit a card may ask for. */
export const RUN_TIMEOUT_MAX_SECS = 60 * 60;
/** The most inputs one card declares. */
export const RUN_INPUTS_MAX = 8;
/** What runs a script whose first line is not a `#!` line: bash without profile or rc files. */
export const RUN_INTERPRETER = '/bin/bash';
/** The arguments bash gets ahead of a script that names no interpreter. */
const RUN_INTERPRETER_ARGS: readonly string[] = ['--noprofile', '--norc'];
/** The option that declines a run card. */
export const RUN_DECLINE_OPTION = 'Decline';

/** What the agent gets back: the exit code and scrubbed output, or the exit code only. */
export type RunOutputMode = 'scrubbed' | 'exit';
export const RUN_OUTPUT_MODES: readonly RunOutputMode[] = ['scrubbed', 'exit'];

/** One value the script reads on stdin. A secret one is masked on the card. */
export interface RunInput {
  name: string;
  secret: boolean;
}

/** The run a card carries, as stored on its decision. The script itself is in `run/script`. */
export interface RunCard {
  /** Hex SHA-256 of the script, taken when the card was posted. */
  scriptSha256: string;
  scriptBytes: number;
  inputs: RunInput[];
  /** The directory the script runs in: absolute, and a directory when posted. */
  cwd: string;
  timeoutSecs: number;
  output: RunOutputMode;
  /** The command that runs the script, as the card shows it: its `#!` line's, or `/bin/bash` when it has none. */
  interpreter: string;
  /** The trap whose proposal this card carries, when the helm posted one. */
  proposedBy?: string;
  /** The script prompts as it runs: it gets a terminal, and the card a line console (run-exec.ts). */
  interactive?: boolean;
}

/** What relays a terminal to an interactive run: expect(1), which ships with macOS. */
export const RUN_RELAY = '/usr/bin/expect';

/** A refused run card or proposal. */
export class RunCardError extends Error {}

/** A script whose `#!` interpreter is not installed on this Mac. */
export class ScriptInterpreterMissing extends RunCardError {
  /** The program that was not found: `python3`, or an absolute path. */
  readonly program: string;
  constructor(message: string, program: string) {
    super(message);
    this.program = program;
  }
}

const INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** `NAME`, `NAME:secret` or `NAME:text`. An input is secret unless it says text. */
export function parseRunInput(raw: string): RunInput {
  const [name = '', kind, ...rest] = raw.split(':');
  if (rest.length || !INPUT_NAME_RE.test(name)) throw new RunCardError(`--input takes NAME, NAME:secret or NAME:text (a shell-style name): ${raw}`);
  if (kind !== undefined && kind !== 'secret' && kind !== 'text') throw new RunCardError(`--input kind is secret or text: ${raw}`);
  return { name, secret: kind !== 'text' };
}

/** `90s`, `5m`, `1h` or a number of seconds, from 1 second to RUN_TIMEOUT_MAX_SECS. */
export function parseRunTimeout(raw: string): number {
  const m = /^(\d+)\s*(s|m|h)?$/.exec(raw.trim());
  if (!m) throw new RunCardError(`--timeout takes seconds or a duration such as 90s, 5m or 1h: ${raw}`);
  const secs = Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
  if (secs < 1 || secs > RUN_TIMEOUT_MAX_SECS) throw new RunCardError(`--timeout must be between 1s and ${RUN_TIMEOUT_MAX_SECS / 60}m`);
  return secs;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A script file's bytes, refused unless it is a regular UTF-8 file of 1 to RUN_SCRIPT_MAX_BYTES bytes. */
export function readRunScriptFile(file: string): Buffer {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new RunCardError(`script does not exist: ${file}`);
  }
  if (!stat.isFile()) throw new RunCardError(`script is not a regular file: ${file}`);
  if (stat.size > RUN_SCRIPT_MAX_BYTES) throw new RunCardError(`script exceeds ${RUN_SCRIPT_MAX_BYTES} bytes (16 KB), so a card could not show it whole: ${file}`);
  const data = fs.readFileSync(file);
  if (data.length === 0) throw new RunCardError(`script is empty: ${file}`);
  if (data.length > RUN_SCRIPT_MAX_BYTES) throw new RunCardError(`script exceeds ${RUN_SCRIPT_MAX_BYTES} bytes (16 KB), so a card could not show it whole: ${file}`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new RunCardError(`script is not UTF-8 text: ${file}`);
  }
  return data;
}

/**
 * The program that runs a script, as its first line names it. A script that
 * starts `#!/usr/bin/env python3` runs as `/usr/bin/env python3 <script>`,
 * never under bash: bash would read a Python docstring as commands and run
 * every backtick-quoted command in it.
 */
export interface ScriptInterpreter {
  /** Where the interpreter came from: the script's `#!` line, or bash for a script without one. */
  source: 'shebang' | 'default';
  /** The interpreter's absolute path. */
  program: string;
  /** Its arguments ahead of the script: those on the `#!` line, split on whitespace as macOS does. */
  args: string[];
  /** The command the `#!` line names, as the card shows it: `/usr/bin/env python3`. */
  label: string;
}

/** The interpreter a script's `#!` line names, or bash when it has none. Refuses a `#!` line without an absolute program. */
export function scriptInterpreter(text: string): ScriptInterpreter {
  if (!text.startsWith('#!')) return { source: 'default', program: RUN_INTERPRETER, args: [...RUN_INTERPRETER_ARGS], label: RUN_INTERPRETER };
  const newline = text.indexOf('\n');
  const words = text.slice(2, newline < 0 ? undefined : newline).trim().split(/\s+/).filter(Boolean);
  const [program, ...args] = words;
  if (program === undefined) throw new RunCardError('the script starts with #! but names no interpreter');
  if (!path.isAbsolute(program)) throw new RunCardError(`the script's #! line must name an absolute path, such as /usr/bin/env ${program}: ${program}`);
  return { source: 'shebang', program, args, label: words.join(' ') };
}

/** The program `/usr/bin/env` looks up on PATH: its first argument that is not an option or a NAME=value setting. */
function envTarget(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
}

/** Whether a file exists and this user may execute it. */
function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Refuse a script whose interpreter is not on this Mac: the `#!` program
 * must exist and be executable, and for `/usr/bin/env <name>` the name must
 * be found on `searchPath` (the PATH the run gets).
 *
 * The check runs only on a POSIX system, where the glass can run a card. On
 * Windows a `#!` program such as `/bin/bash` has no file at that path and the
 * glass doesn't run cards, so posting one there checks nothing.
 */
export function checkScriptInterpreter(interpreter: ScriptInterpreter, searchPath: string = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  if (!isExecutable(interpreter.program))
    throw new ScriptInterpreterMissing(`the script's #! line names ${interpreter.label}, but ${interpreter.program} is not an executable file on this Mac`, interpreter.program);
  if (path.basename(interpreter.program) !== 'env') return;
  const target = envTarget(interpreter.args);
  if (target === undefined) throw new RunCardError(`the script's #! line names ${interpreter.label}, which names no program for env to run`);
  const found = target.includes('/') ? isExecutable(target) : searchPath.split(path.delimiter).some((dir) => dir && isExecutable(path.join(dir, target)));
  if (!found) throw new ScriptInterpreterMissing(`the script's #! line names ${interpreter.label}, but ${target} is not installed on PATH`, target);
}

/** The interpreter of a script file's text, refused when it is not installed. */
export function resolveScriptInterpreter(text: string, searchPath?: string): ScriptInterpreter {
  const interpreter = scriptInterpreter(text);
  checkScriptInterpreter(interpreter, searchPath);
  return interpreter;
}

/** The argv that runs `scriptFile` under the interpreter its text names. */
export function runScriptCommand(text: string, scriptFile: string): string[] {
  const { program, args } = scriptInterpreter(text);
  return [program, ...args, scriptFile];
}

/** What `man ask --run` asks for, before it is checked. */
export interface RunCardRequest {
  scriptFile: string;
  inputs?: string[];
  cwd?: string;
  timeout?: string;
  output?: string;
  proposedBy?: string;
  /** The script prompts as it runs (`--interactive`). */
  interactive?: boolean;
  /** Where the terminal relay is looked for (tests). */
  relay?: string;
}

/** Check a run card's request and read its script. Nothing is written. */
export function prepareRunCard(req: RunCardRequest): { card: RunCard; script: Buffer } {
  const script = readRunScriptFile(req.scriptFile);
  const interpreter = resolveScriptInterpreter(script.toString('utf8'));
  const inputs = (req.inputs ?? []).map(parseRunInput);
  if (inputs.length > RUN_INPUTS_MAX) throw new RunCardError(`a run card takes at most ${RUN_INPUTS_MAX} inputs`);
  if (new Set(inputs.map((i) => i.name)).size !== inputs.length) throw new RunCardError('input names must differ');
  const cwd = path.resolve(req.cwd ?? process.cwd());
  let dir: fs.Stats | undefined;
  try {
    dir = fs.statSync(cwd);
  } catch {
    dir = undefined;
  }
  if (!dir?.isDirectory()) throw new RunCardError(`--cwd is not a directory: ${cwd}`);
  if (req.interactive && !fs.existsSync(req.relay ?? RUN_RELAY)) throw new RunCardError(`--interactive needs expect(1) at ${req.relay ?? RUN_RELAY}, which relays the run's terminal`);
  // An interactive transcript can hold any line Chris typed: unless asked, the agent gets the exit code only.
  const output = (req.output ?? (req.interactive ? 'exit' : 'scrubbed')) as RunOutputMode;
  if (!RUN_OUTPUT_MODES.includes(output)) throw new RunCardError(`--output is scrubbed or exit: ${req.output}`);
  return {
    script,
    card: {
      scriptSha256: sha256Hex(script),
      scriptBytes: script.length,
      inputs,
      cwd,
      timeoutSecs: req.timeout !== undefined ? parseRunTimeout(req.timeout) : RUN_TIMEOUT_DEFAULT_SECS,
      output,
      interpreter: interpreter.label,
      ...(req.proposedBy ? { proposedBy: req.proposedBy } : {}),
      ...(req.interactive ? { interactive: true } : {}),
    },
  };
}

/** The stored copy of a run card's script, inside its decision directory. */
export function runScriptFile(decisionDir: string): string {
  return path.join(decisionDir, 'run', 'script');
}

/** The stored script's text and its hash now, or undefined when the copy is gone. */
export function readStoredRunScript(decisionDir: string): { text: string; sha256: string } | undefined {
  try {
    const data = fs.readFileSync(runScriptFile(decisionDir));
    return { text: data.toString('utf8'), sha256: sha256Hex(data) };
  } catch {
    return undefined;
  }
}

/** A character in a script that a reader could miss or misread: where it is, its code point and what it is. */
export interface ScriptWarning {
  /** 1-based line and column (in code points) of the character. */
  line: number;
  column: number;
  /** `U+202E`. */
  codePoint: string;
  name: string;
  kind: 'bidi' | 'zero-width' | 'control' | 'non-ascii';
}

const NAMED: Record<number, { name: string; kind: ScriptWarning['kind'] }> = {
  0x061c: { name: 'ARABIC LETTER MARK', kind: 'bidi' },
  0x200e: { name: 'LEFT-TO-RIGHT MARK', kind: 'bidi' },
  0x200f: { name: 'RIGHT-TO-LEFT MARK', kind: 'bidi' },
  0x202a: { name: 'LEFT-TO-RIGHT EMBEDDING', kind: 'bidi' },
  0x202b: { name: 'RIGHT-TO-LEFT EMBEDDING', kind: 'bidi' },
  0x202c: { name: 'POP DIRECTIONAL FORMATTING', kind: 'bidi' },
  0x202d: { name: 'LEFT-TO-RIGHT OVERRIDE', kind: 'bidi' },
  0x202e: { name: 'RIGHT-TO-LEFT OVERRIDE', kind: 'bidi' },
  0x2066: { name: 'LEFT-TO-RIGHT ISOLATE', kind: 'bidi' },
  0x2067: { name: 'RIGHT-TO-LEFT ISOLATE', kind: 'bidi' },
  0x2068: { name: 'FIRST STRONG ISOLATE', kind: 'bidi' },
  0x2069: { name: 'POP DIRECTIONAL ISOLATE', kind: 'bidi' },
  0x200b: { name: 'ZERO WIDTH SPACE', kind: 'zero-width' },
  0x200c: { name: 'ZERO WIDTH NON-JOINER', kind: 'zero-width' },
  0x200d: { name: 'ZERO WIDTH JOINER', kind: 'zero-width' },
  0x2060: { name: 'WORD JOINER', kind: 'zero-width' },
  0xfeff: { name: 'ZERO WIDTH NO-BREAK SPACE', kind: 'zero-width' },
  0x00ad: { name: 'SOFT HYPHEN', kind: 'zero-width' },
  0x00a0: { name: 'NO-BREAK SPACE', kind: 'non-ascii' },
};

/** The code point as `U+XXXX`. */
export const codePointLabel = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Every character a reader of the card could miss or misread: bidi controls,
 * zero-width characters, control characters other than tab and newline, and
 * any other non-ASCII character (a lookalike letter).
 */
export function scriptWarnings(text: string): ScriptWarning[] {
  const out: ScriptWarning[] = [];
  let line = 1;
  let column = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\n') {
      line += 1;
      column = 0;
      continue;
    }
    column += 1;
    const named = NAMED[cp];
    if (named) out.push({ line, column, codePoint: codePointLabel(cp), ...named });
    // A carriage return can redraw a line over what runs, so only a tab passes.
    else if ((cp < 0x20 && ch !== '\t') || cp === 0x7f || (cp >= 0x80 && cp < 0xa0))
      out.push({ line, column, codePoint: codePointLabel(cp), name: 'CONTROL CHARACTER', kind: 'control' });
    else if (cp > 0x7e) out.push({ line, column, codePoint: codePointLabel(cp), name: 'NON-ASCII CHARACTER', kind: 'non-ascii' });
  }
  return out;
}

/** A trap's script, proposed to the helm for a run card (`report needs-decision --run`). */
export interface RunProposal {
  dispatch: string;
  /** The trap that proposed it, when the report came from one. */
  trap?: string;
  sha256: string;
  /** The stored copy the helm posts with `man ask <dispatch> --run <file>`. */
  file: string;
  at: string;
}

const DISPATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export function runProposalsDir(dispatch: string): string {
  if (!DISPATCH_ID_RE.test(dispatch)) throw new RunCardError(`not a dispatch id: ${dispatch}`);
  return path.join(lobstahHome(), 'run-proposals', dispatch);
}

/**
 * The name a proposal's copy keeps: the trap's own file name and extension,
 * with any character outside letters, digits, `.`, `_`, `+` and `-` turned
 * into `_`, so the `man ask --run <file>` the note offers copies as one word.
 */
export function runProposalFileName(scriptFile: string): string {
  const name = path.basename(scriptFile).replace(/[^A-Za-z0-9._+-]/g, '_');
  return name.startsWith('-') ? `_${name.slice(1)}` : name;
}

/**
 * Store a trap's proposed script under its dispatch, by hash:
 * `<dispatch>/<sha256>/<its file name>`, so a `deploy.py` stays `deploy.py`.
 * Proposing the same script again keeps one copy. A script whose `#!`
 * interpreter is not installed is refused.
 */
export function proposeRunScript(dispatch: string, scriptFile: string, trap?: string, now = new Date()): RunProposal {
  const script = readRunScriptFile(scriptFile);
  resolveScriptInterpreter(script.toString('utf8'));
  const sha256 = sha256Hex(script);
  const dir = runProposalsDir(dispatch);
  const copyDir = path.join(dir, sha256);
  fs.mkdirSync(copyDir, { recursive: true });
  // The same script proposed again under another name keeps the first copy.
  const kept = fs.readdirSync(copyDir)[0];
  const file = path.join(copyDir, kept ?? runProposalFileName(scriptFile));
  if (kept === undefined) fs.writeFileSync(file, script, { mode: 0o600 });
  const proposal: RunProposal = { dispatch, ...(trap ? { trap } : {}), sha256, file, at: now.toISOString() };
  fs.writeFileSync(path.join(dir, `${sha256}.json`), `${JSON.stringify(proposal, null, 2)}\n`);
  return proposal;
}

/** A dispatch's proposal with this script hash, if a trap proposed it. */
export function findRunProposal(dispatch: string, sha256: string): RunProposal | undefined {
  if (!DISPATCH_ID_RE.test(dispatch) || !/^[a-f0-9]{64}$/.test(sha256)) return undefined;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(runProposalsDir(dispatch), `${sha256}.json`), 'utf8')) as RunProposal;
    return p.sha256 === sha256 && p.dispatch === dispatch ? p : undefined;
  } catch {
    return undefined;
  }
}
