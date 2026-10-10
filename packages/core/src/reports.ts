import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AttachmentError, copyAttachments } from './attachments.js';
import { uniqueTempPath, atomicRenameSync, laneDirs, lobstahHome } from './paths.js';
import type { Attachment, Lane } from './types.js';

/**
 * Reports: a page of markdown that ends a dispatch (`report done|failed
 * --report <file.md>`) or that a helm files (`man file <file.md>`).
 *
 * A dispatch's report lives in its state directory, `state/<id>/report.md`
 * beside `attachments/`. A helm's report lives under its grounds,
 * `reports/<grounds>/<rid>/`, with the same layout. `report.json` beside
 * each holds the metadata. An image the markdown names by bare filename
 * resolves to that report's own attachments directory, never elsewhere.
 */

export interface ReportMeta {
  /** `report:<lane>:<id>` for a dispatch, `report:helm:<grounds>:<rid>` for a helm. */
  key: string;
  title: string;
  /** The trap name, `headless`, or `helm`. */
  author: string;
  filedAt: string;
  /** Changes with every filing; an ack holds only while it matches. */
  stateHash: string;
  bytes: number;
  dispatch?: string;
  lane?: Lane;
  /** The trap name, when a trap filed it. */
  trap?: string;
  grounds?: string;
  repo?: string;
  attachments: Attachment[];
  /** Attached basename → stored name, where a name was already taken. */
  renamed?: Record<string, string>;
}

export class ReportError extends Error {}

const REPORT_MD = 'report.md';
const REPORT_JSON = 'report.json';

export function helmReportsRoot(): string {
  return path.join(lobstahHome(), 'reports');
}

export function dispatchReportKey(id: string, lane: Lane): string {
  return `report:${lane}:${id}`;
}

const GROUNDS_RE = /^[A-Za-z0-9._-]+$/;
const RID_RE = /^[a-f0-9]{8}$/;

/** The directory a report key names, or undefined for a malformed key. Never a path the key spells. */
export function reportDir(key: string): string | undefined {
  const d = /^report:(work|chore):([A-Za-z0-9-]+)$/.exec(key);
  if (d) return path.join(laneDirs(d[1] as Lane).state, d[2]!);
  const h = /^report:helm:([^:]+):([^:]+)$/.exec(key);
  if (h && GROUNDS_RE.test(h[1]!) && !h[1]!.startsWith('.') && RID_RE.test(h[2]!)) return path.join(helmReportsRoot(), h[1]!, h[2]!);
  return undefined;
}

/** The first level-one `#` heading of a markdown page. */
export function markdownTitle(markdown: string): string | undefined {
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** A brief's title: its first `#` heading, else its first non-empty line. */
export function briefTitle(brief: string): string {
  const title = markdownTitle(brief) ?? brief.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return title.length > 100 ? `${title.slice(0, 99)}…` : title;
}

export interface FileReportOptions {
  key: string;
  /** The markdown file to copy. */
  file: string;
  /** Files to attach; images the markdown names by bare filename resolve here. */
  attach?: string[];
  /** An explicit title; else the markdown's first `#` heading; else `fallbackTitle`. */
  title?: string;
  fallbackTitle: string;
  author: string;
  maxBytes: number;
  dispatch?: string;
  lane?: Lane;
  trap?: string;
  grounds?: string;
  repo?: string;
  now?: Date;
}

/**
 * Copy a markdown file and its attachments into the key's directory and
 * record the metadata. Every source is checked before anything is copied:
 * a refused file leaves nothing behind. Filing again for the same key
 * replaces the page; earlier attachments stay.
 */
export function fileReport(opts: FileReportOptions): ReportMeta {
  const dir = reportDir(opts.key);
  if (!dir) throw new ReportError(`not a report key: ${opts.key}`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(opts.file);
  } catch {
    throw new ReportError(`report file does not exist: ${opts.file}`);
  }
  if (!stat.isFile()) throw new ReportError(`report file is not a regular file: ${opts.file}`);
  if (stat.size > opts.maxBytes) throw new ReportError(`report file exceeds ${opts.maxBytes} bytes: ${opts.file}`);
  const markdown = fs.readFileSync(opts.file, 'utf8');
  fs.mkdirSync(dir, { recursive: true });
  let attached: Attachment[];
  try {
    attached = copyAttachments(opts.attach ?? [], path.join(dir, 'attachments'), opts.maxBytes);
  } catch (err) {
    if (err instanceof AttachmentError) throw new ReportError(err.message);
    throw err;
  }
  const previous = readReportAt(dir);
  const renamed: Record<string, string> = { ...previous?.renamed };
  (opts.attach ?? []).forEach((file, i) => {
    const base = path.basename(file);
    if (attached[i] && attached[i]!.name !== base) renamed[base] = attached[i]!.name;
  });
  const filedAt = (opts.now ?? new Date()).toISOString();
  const meta: ReportMeta = {
    key: opts.key,
    title: opts.title?.trim() || markdownTitle(markdown) || opts.fallbackTitle || opts.key,
    author: opts.author,
    filedAt,
    stateHash: createHash('sha1').update(`${opts.key}\n${filedAt}\n${markdown}`).digest('hex').slice(0, 16),
    bytes: Buffer.byteLength(markdown),
    ...(opts.dispatch ? { dispatch: opts.dispatch } : {}),
    ...(opts.lane ? { lane: opts.lane } : {}),
    ...(opts.trap ? { trap: opts.trap } : {}),
    ...(opts.grounds ? { grounds: opts.grounds } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    attachments: [...(previous?.attachments ?? []).filter((a) => !attached.some((b) => b.name === a.name)), ...attached],
    ...(Object.keys(renamed).length ? { renamed } : {}),
  };
  const write = (name: string, content: string) => {
    const file = path.join(dir, name);
    const tmp = uniqueTempPath(file);
    fs.writeFileSync(tmp, content);
    atomicRenameSync(tmp, file);
  };
  write(REPORT_MD, markdown);
  write(REPORT_JSON, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/** A new helm report key under a grounds. */
export function newHelmReportKey(grounds: string): string {
  if (!GROUNDS_RE.test(grounds) || grounds.startsWith('.')) throw new ReportError(`not a grounds name: ${grounds}`);
  return `report:helm:${grounds}:${randomBytes(4).toString('hex')}`;
}

function readReportAt(dir: string): ReportMeta | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, REPORT_JSON), 'utf8')) as ReportMeta;
    return typeof meta.key === 'string' && typeof meta.filedAt === 'string' ? meta : undefined;
  } catch {
    return undefined;
  }
}

export function readReport(key: string): ReportMeta | undefined {
  const dir = reportDir(key);
  const meta = dir ? readReportAt(dir) : undefined;
  return meta?.key === key ? meta : undefined;
}

/** The report's markdown path, when the report exists. */
export function reportMarkdownPath(key: string): string | undefined {
  const dir = reportDir(key);
  const file = dir && path.join(dir, REPORT_MD);
  return file && readReport(key) && fs.existsSync(file) ? file : undefined;
}

export function readReportMarkdown(key: string): string | undefined {
  const file = reportMarkdownPath(key);
  try {
    return file ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An attachment of the report by basename: the attached name (resolved
 * through a rename) or the stored name. Only a file in the report's own
 * attachments directory resolves; any path, `..`, or unknown name does not.
 */
export function resolveReportFile(key: string, name: string): string | undefined {
  if (!name || name !== path.basename(name) || name !== path.win32.basename(name) || name === '.' || name === '..') return undefined;
  const meta = readReport(key);
  const dir = reportDir(key);
  if (!meta || !dir) return undefined;
  const stored = meta.renamed?.[name] ?? name;
  const hit = meta.attachments.find((a) => a.name === stored);
  if (!hit) return undefined;
  const file = path.join(dir, 'attachments', hit.name);
  return fs.existsSync(file) ? file : undefined;
}

/** Every report on disk, newest first. */
export function listReports(): ReportMeta[] {
  const found: ReportMeta[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(laneDirs(lane).state);
    } catch {
      // no state yet
    }
    for (const id of names) {
      const meta = readReportAt(path.join(laneDirs(lane).state, id));
      if (meta?.key === dispatchReportKey(id, lane)) found.push(meta);
    }
  }
  let grounds: string[] = [];
  try {
    grounds = fs.readdirSync(helmReportsRoot());
  } catch {
    // no helm reports yet
  }
  for (const g of grounds) {
    let rids: string[] = [];
    try {
      rids = fs.readdirSync(path.join(helmReportsRoot(), g));
    } catch {
      continue;
    }
    for (const rid of rids) {
      const meta = readReportAt(path.join(helmReportsRoot(), g, rid));
      if (meta?.key === `report:helm:${g}:${rid}`) found.push(meta);
    }
  }
  return found.sort((a, b) => b.filedAt.localeCompare(a.filedAt) || a.key.localeCompare(b.key));
}

/** Remove a helm report's directory. A dispatch's report goes with its state (cull). */
export function removeHelmReport(key: string): void {
  if (!key.startsWith('report:helm:')) return;
  const dir = reportDir(key);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
