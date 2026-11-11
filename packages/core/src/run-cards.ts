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
/** What runs the script: bash without profile or rc files. */
export const RUN_INTERPRETER = '/bin/bash';
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
      interpreter: RUN_INTERPRETER,
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

/** Store a trap's proposed script under its dispatch, by hash. Proposing the same script again keeps one copy. */
export function proposeRunScript(dispatch: string, scriptFile: string, trap?: string, now = new Date()): RunProposal {
  const script = readRunScriptFile(scriptFile);
  const sha256 = sha256Hex(script);
  const dir = runProposalsDir(dispatch);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha256}.sh`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, script, { mode: 0o600 });
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
