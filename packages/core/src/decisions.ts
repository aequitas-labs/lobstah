import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AttachmentError, copyAttachments } from './attachments.js';
import { lobstahHome } from './paths.js';
import type { Attachment, Lane } from './types.js';

/**
 * Decisions: a question the helm puts to the human (`man ask`), answered in
 * the glass or with `man answer`.
 *
 * Each decision has its own directory, `decisions/<rid>/`: `decision.json`
 * (the record), `detail.md`, `attachments/` (the helm's files), and, once
 * answered, `answer.json` and `answer/` (the human's files). A decision
 * stands until it is answered or withdrawn. A withdrawn decision's directory
 * is removed. An answer is delivered to the helm's `man wait` once, as a
 * `decision-answered` event.
 */

export interface DecisionMeta {
  /** `decision:<rid>`. */
  key: string;
  title: string;
  /** Option labels, 0 to MAX_DECISION_OPTIONS. */
  options: string[];
  /** The helm's attachments. Detail images named by bare filename resolve here. */
  attachments: Attachment[];
  /** Attached basename → stored name, where a name was already taken. */
  renamed?: Record<string, string>;
  detailBytes: number;
  /** The dispatch it is about, when there is one. */
  dispatch?: string;
  lane?: Lane;
  repo?: string;
  /** The asking helm's grounds, when known. */
  grounds?: string;
  /** `helm` for `man ask`; `worker` for a raw question answered in the glass. */
  askedBy: string;
  askedAt: string;
  /** Changes with every ask; an ack holds only while it matches. */
  stateHash: string;
}

export interface DecisionAnswer {
  key: string;
  /** The chosen option label, when one was chosen. */
  option?: string;
  text?: string;
  /** The human's files, stored in the decision's `answer/` directory. */
  attachments: Attachment[];
  answeredAt: string;
  /** Where it was answered: `glass` or `terminal`. */
  by: string;
  /** When `man wait` delivered the `decision-answered` event. */
  deliveredAt?: string;
}

/** A file the glass uploaded: its name as the browser gave it, and its bytes. */
export interface DecisionUpload {
  name: string;
  data: Buffer;
}

/** A refused ask or answer. `status` is the HTTP status the glass returns for it. */
export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const MAX_DECISION_OPTIONS = 6;
export const DECISION_TITLE_MAX = 200;
export const DECISION_OPTION_MAX = 80;
/** The detail page is inlined in every glass snapshot, so it stays small. */
export const DECISION_DETAIL_MAX = 64 * 1024;
/** An answer's text, in characters. */
export const ANSWER_TEXT_MAX = 20_000;
/** Files one answer may carry. */
export const ANSWER_FILES_MAX = 8;

/**
 * File types an answer may attach, by extension. An image must also start
 * with its format's signature.
 */
const ANSWER_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.diff': 'text/plain',
  '.patch': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.toml': 'text/plain',
  '.zip': 'application/zip',
};

/** The extensions an answer accepts, for messages and the glass's file picker. */
export const ANSWER_EXTENSIONS: readonly string[] = Object.keys(ANSWER_TYPES);

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  '.zip': (b) => b[0] === 0x50 && b[1] === 0x4b,
};

const DECISION_JSON = 'decision.json';
const DETAIL_MD = 'detail.md';
const ANSWER_JSON = 'answer.json';
const RID_RE = /^[a-f0-9]{8}$/;

export function decisionsRoot(): string {
  return path.join(lobstahHome(), 'decisions');
}

/** The directory a decision key names, or undefined for a malformed key. Never a path the key spells. */
export function decisionDir(key: string): string | undefined {
  const m = /^decision:([a-f0-9]{8})$/.exec(key);
  return m ? path.join(decisionsRoot(), m[1]!) : undefined;
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readDecision(key: string): DecisionMeta | undefined {
  const dir = decisionDir(key);
  const meta = dir ? readJsonFile<DecisionMeta>(path.join(dir, DECISION_JSON)) : undefined;
  return meta?.key === key ? meta : undefined;
}

export function readDecisionDetail(key: string): string | undefined {
  const dir = decisionDir(key);
  if (!dir || !readDecision(key)) return undefined;
  try {
    return fs.readFileSync(path.join(dir, DETAIL_MD), 'utf8');
  } catch {
    return undefined;
  }
}

export function readDecisionAnswer(key: string): DecisionAnswer | undefined {
  const dir = decisionDir(key);
  const answer = dir ? readJsonFile<DecisionAnswer>(path.join(dir, ANSWER_JSON)) : undefined;
  return answer?.key === key ? answer : undefined;
}

/** Every decision on disk, answered or not, newest first. */
export function listDecisions(): DecisionMeta[] {
  let rids: string[] = [];
  try {
    rids = fs.readdirSync(decisionsRoot());
  } catch {
    return [];
  }
  return rids
    .filter((rid) => RID_RE.test(rid))
    .map((rid) => readDecision(`decision:${rid}`))
    .filter((d): d is DecisionMeta => d !== undefined)
    .sort((a, b) => b.askedAt.localeCompare(a.askedAt) || a.key.localeCompare(b.key));
}

/** Decisions not yet answered, newest first. */
export function standingDecisions(): DecisionMeta[] {
  return listDecisions().filter((d) => readDecisionAnswer(d.key) === undefined);
}

export interface AskOptions {
  title: string;
  /** A markdown file to copy as the detail page. */
  detailFile?: string;
  /** Markdown text as the detail page (the glass's framing of a raw question). */
  detailText?: string;
  options?: string[];
  attach?: string[];
  dispatch?: string;
  lane?: Lane;
  repo?: string;
  grounds?: string;
  askedBy: string;
  /** Replace a standing decision on the same dispatch (default true). */
  replace?: boolean;
  /** Per-file limit for attachments (limits.attachmentMaxBytes). */
  maxBytes: number;
  now?: Date;
}

function checkTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new DecisionError('a decision needs a title');
  if (title.length > DECISION_TITLE_MAX) throw new DecisionError(`the title exceeds ${DECISION_TITLE_MAX} characters`);
  return title;
}

function checkOptions(raw: string[]): string[] {
  const options = raw.map((o) => o.trim());
  if (options.length > MAX_DECISION_OPTIONS) throw new DecisionError(`a decision takes at most ${MAX_DECISION_OPTIONS} options`);
  for (const o of options) {
    if (!o) throw new DecisionError('an option label is empty');
    if (o.length > DECISION_OPTION_MAX) throw new DecisionError(`option "${o.slice(0, 20)}…" exceeds ${DECISION_OPTION_MAX} characters`);
  }
  if (new Set(options).size !== options.length) throw new DecisionError('option labels must differ');
  return options;
}

/**
 * Store a decision. Every input is checked before anything is written. A
 * standing decision on the same dispatch is replaced: its directory is
 * removed and its key returned in `replaced`.
 */
export function askDecision(opts: AskOptions): { meta: DecisionMeta; replaced: string[] } {
  const title = checkTitle(opts.title);
  const options = checkOptions(opts.options ?? []);
  let detail = opts.detailText ?? '';
  if (opts.detailFile !== undefined) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(opts.detailFile);
    } catch {
      throw new DecisionError(`detail file does not exist: ${opts.detailFile}`);
    }
    if (!stat.isFile()) throw new DecisionError(`detail file is not a regular file: ${opts.detailFile}`);
    if (stat.size > DECISION_DETAIL_MAX) throw new DecisionError(`detail file exceeds ${DECISION_DETAIL_MAX} bytes: ${opts.detailFile}`);
    detail = fs.readFileSync(opts.detailFile, 'utf8');
  }
  if (Buffer.byteLength(detail) > DECISION_DETAIL_MAX) throw new DecisionError(`detail exceeds ${DECISION_DETAIL_MAX} bytes`);
  let rid = randomBytes(4).toString('hex');
  while (fs.existsSync(path.join(decisionsRoot(), rid))) rid = randomBytes(4).toString('hex');
  const key = `decision:${rid}`;
  const dir = path.join(decisionsRoot(), rid);
  fs.mkdirSync(dir, { recursive: true });
  let attached: Attachment[];
  try {
    attached = copyAttachments(opts.attach ?? [], path.join(dir, 'attachments'), opts.maxBytes);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (err instanceof AttachmentError) throw new DecisionError(err.message);
    throw err;
  }
  const renamed: Record<string, string> = {};
  (opts.attach ?? []).forEach((file, i) => {
    const base = path.basename(file);
    if (attached[i] && attached[i]!.name !== base) renamed[base] = attached[i]!.name;
  });
  const askedAt = (opts.now ?? new Date()).toISOString();
  const meta: DecisionMeta = {
    key,
    title,
    options,
    attachments: attached,
    ...(Object.keys(renamed).length ? { renamed } : {}),
    detailBytes: Buffer.byteLength(detail),
    ...(opts.dispatch ? { dispatch: opts.dispatch } : {}),
    ...(opts.lane ? { lane: opts.lane } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.grounds ? { grounds: opts.grounds } : {}),
    askedBy: opts.askedBy,
    askedAt,
    stateHash: createHash('sha1').update(`${key}\n${askedAt}\n${title}`).digest('hex').slice(0, 16),
  };
  writeAtomic(path.join(dir, DETAIL_MD), detail);
  writeAtomic(path.join(dir, DECISION_JSON), `${JSON.stringify(meta, null, 2)}\n`);
  const replaced = opts.dispatch && opts.replace !== false
    ? standingDecisions().filter((d) => d.key !== key && d.dispatch === opts.dispatch && d.lane === opts.lane).map((d) => d.key)
    : [];
  for (const old of replaced) fs.rmSync(decisionDir(old)!, { recursive: true, force: true });
  return { meta, replaced };
}

/** Withdraw a standing decision: its directory is removed. An answered one stays. */
export function withdrawDecision(key: string): DecisionMeta {
  const meta = readDecision(key);
  if (!meta) throw new DecisionError(`no decision ${key}`, 404);
  const answer = readDecisionAnswer(key);
  if (answer) throw new DecisionError(`decision ${key} was already answered at ${answer.answeredAt}`, 409);
  fs.rmSync(decisionDir(key)!, { recursive: true, force: true });
  return meta;
}

/** A plain basename for an uploaded file, or undefined when none is left. */
function uploadName(raw: string): string | undefined {
  const base = path.win32.basename(path.posix.basename(raw)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return undefined;
  return base.length > 120 ? base.slice(base.length - 120) : base;
}

/** The type an answer file is stored as, or a DecisionError. */
function answerFileType(name: string, head: Buffer): string {
  const ext = path.extname(name).toLowerCase();
  const type = ANSWER_TYPES[ext];
  if (!type) throw new DecisionError(`file type not accepted: ${name} (accepted: ${ANSWER_EXTENSIONS.join(' ')})`, 415);
  const sig = SIGNATURES[ext];
  if (sig && !sig(head)) throw new DecisionError(`file content does not match its type: ${name}`, 415);
  return type;
}

export interface AnswerInput {
  key: string;
  option?: string;
  text?: string;
  /** Files on disk (`man answer --attach`). */
  attach?: string[];
  /** Files the glass uploaded. */
  uploads?: DecisionUpload[];
  by: string;
  /** Per-file limit (limits.attachmentMaxBytes). */
  maxBytes: number;
  now?: Date;
}

/**
 * Answer a standing decision. The key, option, text, and every file are
 * checked before anything is written; then the files are stored in the
 * decision's `answer/` directory and the answer record is written. It runs
 * nothing and messages nobody: `man wait` delivers it to the helm.
 */
export function answerDecision(input: AnswerInput): DecisionAnswer {
  const meta = readDecision(input.key);
  if (!meta) throw new DecisionError(`no decision ${input.key}`, 404);
  const previous = readDecisionAnswer(input.key);
  if (previous) throw new DecisionError(`decision ${input.key} was already answered at ${previous.answeredAt}`, 409);
  const option = input.option === undefined || input.option === '' ? undefined : input.option;
  if (option !== undefined && !meta.options.includes(option)) {
    throw new DecisionError(
      meta.options.length ? `"${option}" is not an option: ${meta.options.map((o) => `"${o}"`).join(', ')}` : `${input.key} has no options`,
    );
  }
  const text = input.text?.trim() ? input.text.replace(/\r\n/g, '\n').trim() : undefined;
  if (text !== undefined && text.length > ANSWER_TEXT_MAX) throw new DecisionError(`the answer text exceeds ${ANSWER_TEXT_MAX} characters`, 413);
  const files: Array<{ name: string; read: () => Buffer }> = [];
  for (const file of input.attach ?? []) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new DecisionError(`attachment does not exist: ${file}`);
    }
    if (!stat.isFile()) throw new DecisionError(`attachment is not a regular file: ${file}`);
    if (stat.size > input.maxBytes) throw new DecisionError(`attachment exceeds ${input.maxBytes} bytes: ${file}`, 413);
    const name = uploadName(file);
    if (!name) throw new DecisionError(`attachment has no usable name: ${file}`);
    files.push({ name, read: () => fs.readFileSync(file) });
  }
  for (const up of input.uploads ?? []) {
    const name = uploadName(up.name);
    if (!name) throw new DecisionError(`attachment has no usable name: ${JSON.stringify(up.name)}`);
    if (up.data.length > input.maxBytes) throw new DecisionError(`attachment exceeds ${input.maxBytes} bytes: ${name}`, 413);
    files.push({ name, read: () => up.data });
  }
  if (files.length > ANSWER_FILES_MAX) throw new DecisionError(`an answer takes at most ${ANSWER_FILES_MAX} files`, 413);
  const contents = files.map((f) => {
    const data = f.read();
    if (data.length > input.maxBytes) throw new DecisionError(`attachment exceeds ${input.maxBytes} bytes: ${f.name}`, 413);
    return { name: f.name, data, type: answerFileType(f.name, data) };
  });
  if (option === undefined && text === undefined && contents.length === 0) {
    throw new DecisionError('an answer needs an option, text, or a file');
  }
  const dir = decisionDir(input.key)!;
  const answerDir = path.join(dir, 'answer');
  const stored: Attachment[] = [];
  if (contents.length) fs.mkdirSync(answerDir, { recursive: true });
  try {
    for (const c of contents) {
      const ext = path.extname(c.name);
      const stem = c.name.slice(0, c.name.length - ext.length);
      let name = c.name;
      let n = 2;
      while (stored.some((s) => s.name === name) || fs.existsSync(path.join(answerDir, name))) name = `${stem}-${n++}${ext}`;
      const file = path.join(answerDir, name);
      fs.writeFileSync(file, c.data, { flag: 'wx' });
      stored.push({ name, path: file, bytes: c.data.length, type: c.type });
    }
  } catch (err) {
    for (const s of stored) fs.rmSync(s.path, { force: true });
    throw err;
  }
  const answer: DecisionAnswer = {
    key: input.key,
    ...(option !== undefined ? { option } : {}),
    ...(text !== undefined ? { text } : {}),
    attachments: stored,
    answeredAt: (input.now ?? new Date()).toISOString(),
    by: input.by,
  };
  // wx: of two answers racing, the first one written stands.
  try {
    fs.writeFileSync(path.join(dir, ANSWER_JSON), `${JSON.stringify(answer, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    for (const s of stored) fs.rmSync(s.path, { force: true });
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new DecisionError(`decision ${input.key} was already answered`, 409);
    throw err;
  }
  return answer;
}

export interface DecisionAnsweredEvent {
  decision: DecisionMeta;
  answer: DecisionAnswer;
}

/**
 * Answers not yet delivered to the helm, oldest first. With `consume`, each
 * one returned is stamped delivered: an answer is one event. A decision
 * `match` rejects is left for its own grounds' helm.
 */
export function takeDecisionAnswers(consume = true, match?: (d: DecisionMeta) => boolean): DecisionAnsweredEvent[] {
  const out: DecisionAnsweredEvent[] = [];
  for (const decision of listDecisions()) {
    if (match && !match(decision)) continue;
    const answer = readDecisionAnswer(decision.key);
    if (!answer || answer.deliveredAt) continue;
    out.push({ decision, answer });
    if (consume) writeAtomic(path.join(decisionDir(decision.key)!, ANSWER_JSON), `${JSON.stringify({ ...answer, deliveredAt: new Date().toISOString() }, null, 2)}\n`);
  }
  return out.sort((a, b) => a.answer.answeredAt.localeCompare(b.answer.answeredAt));
}

/**
 * One of the decision's own attachments by basename (resolved through a
 * rename). Any path, `..`, or unknown name resolves to nothing.
 */
export function resolveDecisionFile(key: string, name: string): string | undefined {
  if (!name || name !== path.basename(name) || name !== path.win32.basename(name) || name === '.' || name === '..') return undefined;
  const meta = readDecision(key);
  const dir = decisionDir(key);
  if (!meta || !dir) return undefined;
  const stored = meta.renamed?.[name] ?? name;
  const hit = meta.attachments.find((a) => a.name === stored);
  if (!hit) return undefined;
  const file = path.join(dir, 'attachments', hit.name);
  return fs.existsSync(file) ? file : undefined;
}
