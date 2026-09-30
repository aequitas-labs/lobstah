import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  awaitingReply,
  activeIds,
  activityView,
  waitingView,
  DEFAULT_LIMITS,
  readActivity,
  executorPath,
  helmLabel,
  laneDirs,
  listHelms,
  listNotices,
  listTraps,
  trapLastSeen,
  validSessionLink,
  trapLabel,
  trapNamer,
  TRAP_ADDRESS_RE,
  listWatches,
  watchErrorCell,
  loadConfig,
  lobstahVersion,
  pendingIds,
  prBadge,
  readEvidence,
  dispatchWorktree,
  readSessionClaim,
  readStatusLog,
  queuedAt,
  holdReason,
  readHold,
  slotUsage,
  readPrs,
  listReports,
  readReportMarkdown,
  resolveReportFile,
  resolveDecisionFile,
  dispatchAttachmentsDir,
  trapAttachmentsDir,
  DecisionError,
  ANSWER_EXTENSIONS,
  ANSWER_FILES_MAX,
  ANSWER_TEXT_MAX,
} from '@lobstah/core';
import type { Attachment, Descriptor, GlassDispatch, GlassMessage, GlassReport, GlassSnapshot, GlassTrap, Lane } from '@lobstah/core';
import { reportAck } from './report-file.js';
import { glassDecisions } from './decisions.js';
import { answerKey } from './decision-answer.js';
import type { TendAttention } from './tend.js';
import { readMergeView } from '@lobstah/pick';
import { buildTendReport, landedCatches } from './tend.js';
import type { LandedCatch } from './tend.js';
import { GLASS_PAGE } from './glass-page.generated.js';
import { deriveGlassPrs } from './glass-prs.js';
import { worktreeView } from './worktree-view.js';
import { livenessView } from './liveness-view.js';
import { focusRegistration, liveTrap } from './focus.js';
import type { FocusResult } from './focus.js';
import type { TrapRegistration } from '@lobstah/core';

/**
 * The spyglass: a localhost dashboard over ~/.lobstah — the same
 * observational stance as `man tend`, with room for detail a terminal
 * can't afford. It binds 127.0.0.1 only; /data registers no watch, never
 * advances a cursor, and never consumes attention.
 * Look freely, steer only from the helm. The glass writes only through
 * same-origin, token-gated POSTs: focus a live trap, and file a request
 * (`/requests`) that wakes the helm. It runs nothing itself. The
 * ⚙ settings modal's two preferences (view, lobs) are the viewing browser's
 * own, kept in its localStorage — the server has nothing to write.
 */

const REPO_URL = 'https://github.com/aequitas-labs/lobstah';

const readJson = <T>(f: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  } catch {
    return undefined;
  }
};
const listDir = (d: string): string[] => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};
const mtime = (f: string): number => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * A docs/assets file: installed package layout first (dist/ → ../docs), then
 * the workspace (apps/cli/dist/ → ../../../docs). The workspace path was one
 * level too deep, so every workspace-built glass served its HTML for
 * /lob-sprite.png and /star.png: the sprite probe failed and the pixel lob
 * fell back to the waddling emoji.
 */
function assetPath(name: string): string | undefined {
  for (const rel of [`../docs/assets/${name}`, `../../../docs/assets/${name}`]) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url));
      if (fs.existsSync(p)) return p;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Claude Code transcript: the cwd munged to '-' under ~/.claude/projects. */
function transcriptPath(harness?: string, cwd?: string, sessionId?: string): string | undefined {
  if (harness !== 'claude' || !cwd || !sessionId) return undefined;
  const p = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sessionId}.jsonl`);
  return fs.existsSync(p) ? p : undefined;
}

function messageAttachments(dir: string): Attachment[] {
  return [dir, path.join(dir, 'handled')].flatMap((folder) =>
    listDir(folder)
      .filter((file) => file.endsWith('.meta.json'))
      .flatMap((file) => readJson<{ attachments?: Attachment[] }>(path.join(folder, file))?.attachments ?? []),
  );
}

/**
 * A trap's full mail history. Core's unhandledTrapMessages reads only what
 * still waits; the glass also wants what was already delivered, which lives
 * as the same envelopes under handled/.
 */
function trapMessages(trapId: string): GlassMessage[] {
  const dir = path.join(laneDirs('work').inbox, `trap-${trapId}`);
  const parse = (file: string, state: GlassMessage['state']): GlassMessage | undefined => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    const attachments = readJson<{ attachments?: Attachment[] }>(file.replace(/\.msg$/, '.meta.json'))?.attachments;
    try {
      const p = JSON.parse(raw) as { from?: string; at?: string; text?: string };
      return { file: path.basename(file), state, from: p.from ?? 'unknown', at: p.at ?? '', text: p.text ?? '', attachments };
    } catch {
      return { file: path.basename(file), state, from: 'unknown', at: '', text: raw, attachments };
    }
  };
  const rows = [
    ...listDir(dir).filter((f) => f.endsWith('.msg')).map((f) => parse(path.join(dir, f), 'pending')),
    ...listDir(path.join(dir, 'handled')).filter((f) => f.endsWith('.msg')).map((f) => parse(path.join(dir, 'handled', f), 'delivered')),
  ];
  return rows.filter((m): m is GlassMessage => m !== undefined).sort((a, b) => a.file.localeCompare(b.file));
}

/** Activity older than this shows stale. A config error falls back to the default. */
function wedgeSecs(): number {
  try {
    return loadConfig().limits.wedgeThresholdSecs;
  } catch {
    return DEFAULT_LIMITS.wedgeThresholdSecs;
  }
}

function dispatchRows(): Array<Omit<GlassDispatch, 'prBadge' | 'prGate'>> {
  const rows: Array<{ lane: Lane; bucket: 'queued' | 'active' | 'done'; d: Descriptor; sort: number }> = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    const dirs = laneDirs(lane);
    for (const id of pendingIds(lane)) {
      const d = readJson<Descriptor>(path.join(dirs.queue, `${id}.json`));
      if (d) rows.push({ lane, bucket: 'queued', d, sort: mtime(path.join(dirs.queue, `${id}.json`)) });
    }
    for (const id of activeIds(lane)) {
      const d = readJson<Descriptor>(path.join(dirs.active, id, 'descriptor.json'));
      if (d) rows.push({ lane, bucket: 'active', d, sort: mtime(path.join(dirs.active, id)) });
    }
    const done = listDir(dirs.done)
      .filter((f) => !f.startsWith('.'))
      .map((id) => ({ id, at: mtime(path.join(dirs.done, id)) }))
      .sort((a, b) => b.at - a.at);
    for (const { id, at } of done) {
      const d = readJson<Descriptor>(path.join(dirs.done, id, 'descriptor.json'));
      if (d) rows.push({ lane, bucket: 'done', d, sort: at });
    }
  }
  const hold = readHold();
  const staleSecs = wedgeSecs();
  return rows
    .map((r) => {
      const id = r.d.id;
      const log = readStatusLog(id, r.lane);
      const last = log.at(-1);
      const claim = r.bucket === 'active' ? readSessionClaim(id, r.lane) : undefined;
      const evidence = readEvidence(id, r.lane);
      const inboxDir = path.join(laneDirs(r.lane).inbox, id);
      return {
        id,
        lane: r.lane,
        bucket: r.bucket,
        repo: r.d.repo,
        for: r.d.for,
        followUp: r.d.followUp,
        brief: r.d.brief,
        attachments: r.d.attachments ?? [],
        messageAttachments: messageAttachments(inboxDir),
        // A queued descriptor with no log is waiting, not unknown; its time
        // is the queue time.
        // An active dispatch a trap claimed, with no log, is working since
        // the claim.
        verb:
          r.bucket === 'queued' && log.length === 0
            ? ('queued' as const)
            : (last?.verb ?? (claim ? ('working' as const) : ('unknown' as const))),
        ...(last?.verb === 'failed' && last.note?.startsWith('budget:') ? { outOfTimeWorkSaved: true } : {}),
        // Held for free space: the note carries the reason.
        note: (r.bucket === 'queued' && r.d.systemRepair?.trapWaitUntil && r.d.for
          ? `repair chore waits for ${r.d.for} until ${r.d.systemRepair.trapWaitUntil}` : undefined) ??
          (r.bucket === 'queued' && hold && r.d.for === undefined ? holdReason(hold) : undefined) ?? last?.note,
        verbAt: last?.at ?? (r.bucket === 'queued' ? queuedAt(id, r.lane) : claim?.at),
        activity: r.bucket === 'active' ? activityView(readActivity(id, r.lane), staleSecs) : undefined,
        waiting: r.bucket === 'active' ? waitingView(last) : undefined,
        claimedBy: claim?.by,
        log,
        inbox: listDir(inboxDir)
          .filter((f) => f.endsWith('.msg'))
          .sort()
          .map((f) => fs.readFileSync(path.join(inboxDir, f), 'utf8').trim()),
        ...awaitingOf(id),
        evidence: Object.keys(evidence).length > 0 ? evidence : undefined,
        ...(r.bucket === 'queued' ? {} : worktreeView(id, r.lane)),
        ...(r.bucket === 'queued' ? {} : livenessView(id, r.lane)),
        // A trap's catch: the trap's own checkout. A headless dispatch: the
        // worktree it ran in, the origin's for a follow-up that reused it.
        transcript: claim
          ? transcriptPath(claim.harness, claim.worktree, claim.sessionId)
          : transcriptPath(evidence.harness, evidence.sessionId ? dispatchWorktree(id, r.lane).path : undefined, evidence.sessionId),
        sort: r.sort,
      };
    })
    .sort((a, b) => b.sort - a.sort);
}

function awaitingOf(id: string): Pick<GlassDispatch, 'awaitingReply'> {
  const e = awaitingReply(id);
  return e ? { awaitingReply: { sentAt: e.sentAt, from: e.from, line: e.line } } : {};
}

/**
 * Attention exactly as `man tend` derives it (the one place kinds are
 * decided), plus the active attentionKinds for the read-only line under the
 * heading. A config error surfaces on the page instead of failing /data.
 */
function attentionSnapshot(): { attention: TendAttention[]; landed: LandedCatch[]; attentionKinds: string[]; attentionError?: string } {
  try {
    const cfg = loadConfig();
    // The pet's list: a question held on the helm's turn is not the human's yet.
    return { attention: buildTendReport().attention.filter((a) => !a.held), landed: landedCatches(cfg), attentionKinds: cfg.attentionKinds };
  } catch (err) {
    return { attention: [], landed: [], attentionKinds: [], attentionError: err instanceof Error ? err.message : String(err) };
  }
}

/** Every filed report, newest first, with its ack. Never its markdown: the modal fetches that. */
function reportRows(): GlassReport[] {
  return listReports().map((r) => {
    const acked = reportAck(r);
    return {
      key: r.key,
      title: r.title,
      author: r.author,
      filedAt: r.filedAt,
      stateHash: r.stateHash,
      ...(acked ? { acked } : {}),
      ...(r.dispatch ? { dispatch: r.dispatch } : {}),
      ...(r.lane ? { lane: r.lane } : {}),
      ...(r.trap ? { trap: r.trap } : {}),
      ...(r.grounds ? { grounds: r.grounds } : {}),
      ...(r.repo ? { repo: r.repo } : {}),
      bytes: r.bytes,
      attachments: r.attachments,
      ...(r.renamed ? { renamed: r.renamed } : {}),
    };
  });
}

/** Image types a report may serve. Anything else (an SVG, a script, HTML) is not served. */
const REPORT_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * `/report/<key>/md` and `/report/<key>/files/<name>`: a report's markdown as
 * text, and an image from that report's own attachments by basename.
 * `/decision/<key>/files/<name>` serves an image from a decision's own
 * attachments the same way. The key names a report or a decision, never a
 * path; a name with any path part is refused.
 */
export function serveReport(url: string, res: http.ServerResponse): boolean {
  const m = /^\/(report|decision)\/([^/?#]+)\/(md|files\/([^/?#]+))$/.exec(url.split('?')[0] ?? '');
  if (!m) return false;
  const headers = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store' };
  const notFound = () => {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  };
  let key: string, name: string | undefined;
  try {
    key = decodeURIComponent(m[2]!);
    name = m[4] !== undefined ? decodeURIComponent(m[4]) : undefined;
  } catch {
    notFound();
    return true;
  }
  const decision = m[1] === 'decision';
  // A decision's detail rides in the snapshot; only its images are served.
  if (decision && m[3] === 'md') return notFound(), true;
  if (m[3] === 'md') {
    const text = readReportMarkdown(key);
    if (text === undefined) return notFound(), true;
    res.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
    return true;
  }
  const file = name === undefined ? undefined : decision ? resolveDecisionFile(key, name) : resolveReportFile(key, name);
  const type = file && REPORT_IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!file || !type) return notFound(), true;
  res.writeHead(200, { ...headers, 'content-type': type });
  res.end(fs.readFileSync(file));
  return true;
}

/**
 * Trap id → name for every trap the page can show: each trap row, and every
 * `wt:<id>` a dispatch, a note, or a log line names. Ids with no known name
 * are left out.
 */
function trapNamesShown(
  traps: GlassTrap[],
  dispatches: GlassDispatch[],
  attention: { attention: TendAttention[]; landed: LandedCatch[] },
  names: (trapId: string) => string | undefined,
): Record<string, string> {
  const ids = new Set(traps.map((t) => t.trapId));
  const scan = (text: string | undefined) => {
    for (const m of (text ?? '').matchAll(TRAP_ADDRESS_RE)) ids.add(m[1]!);
  };
  for (const x of dispatches) {
    for (const v of [x.claimedBy, x.for, x.evidence?.deliveredTo, x.note]) scan(v);
    for (const e of x.log) scan(e.note);
  }
  for (const a of [...attention.attention, ...attention.landed]) scan(a.note);
  const out: Record<string, string> = {};
  for (const id of [...ids].sort()) {
    const name = traps.find((t) => t.trapId === id)?.name ?? names(id);
    if (name) out[id] = name;
  }
  return out;
}

/**
 * `/attachment/dispatch/<lane>/<id>/<name>` and `/attachment/trap/<id>/<name>`:
 * an image from a dispatch's or a trap's own attachments directory, by
 * basename. Nothing but an image in that directory is served.
 */
export function serveAttachment(url: string, res: http.ServerResponse): boolean {
  if (!url.startsWith('/attachment/')) return false;
  const m = /^\/attachment\/(?:dispatch\/(work|chore)\/([^/?#]+)|trap\/([^/?#]+))\/([^/?#]+)$/.exec(url.split('?')[0] ?? '');
  const headers = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store' };
  if (!m) {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  let id: string, name: string;
  try {
    id = decodeURIComponent(m[2] ?? m[3]!);
    name = decodeURIComponent(m[4]!);
  } catch {
    id = '';
    name = '';
  }
  const dir = !/^[A-Za-z0-9-]{1,64}$/.test(id)
    ? undefined
    : m[1]
      ? dispatchAttachmentsDir(id, m[1] as Lane)
      : trapAttachmentsDir(id);
  const plain = name !== '' && !name.includes('\0') && name === path.basename(name) && name === path.win32.basename(name) && name !== '.' && name !== '..';
  const file = dir && plain ? path.join(dir, name) : undefined;
  const type = file && REPORT_IMAGE_TYPES[path.extname(file).toLowerCase()];
  let data: Buffer | undefined;
  try {
    // A symlink is not an attachment image. Read before sending headers so
    // a disappearing or unreadable file is a not-found response too.
    if (file && type && fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) data = fs.readFileSync(file);
  } catch {
    // The attachments may be culled while the glass is open.
  }
  if (!data || !type) {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  res.writeHead(200, { ...headers, 'content-type': type });
  res.end(data);
  return true;
}

/** One disk pass, everything the page renders. Pure read. */
export function buildGlassSnapshot(): GlassSnapshot {
  const executor = readJson<{ heartbeat?: string; version?: string }>(executorPath());
  const workSlots = slotUsage('work');
  const helms = listHelms().map((h) => ({
    ...h,
    session: h.sessionId.slice(0, 8),
    man: helmLabel(h),
    transcript: transcriptPath(h.harness, h.cwd, h.sessionId),
  }));
  const mergeView = readMergeView();
  // PR state per dispatch: the evidence badge (the shared derivation tend and
  // catch use) plus the merge view's gate verdict where pick has one.
  const dispatches = dispatchRows().map((x) => {
    const pr = x.evidence?.pr;
    const url = x.evidence?.prUrl ?? pr?.url;
    const open = mergeView?.open.find((p) => p.uuid === x.id || (url !== undefined && p.url === url));
    return {
      ...x,
      prBadge: pr ? { ...prBadge(pr), observedAt: pr.observedAt } : undefined,
      prGate: open?.gate,
    };
  });
  // The glass shows a failing watch's whole error cell (reason, exit code,
  // remedy, streak start) wherever it shows lastError — the same text as tend.
  const watches = listWatches().map((w) => (w.lastError ? { ...w, lastError: watchErrorCell(w) } : w));
  // PR records first (every observation, man-owned or not); evidence for PRs with none yet.
  const { prs, stacks } = deriveGlassPrs(
    dispatches.map((d) => ({ id: d.id, followUp: d.followUp, repoKey: d.repo, pr: d.evidence?.pr, prGate: d.prGate })),
    watches,
    readPrs(),
  );
  const allNotices = listNotices(Number.MAX_SAFE_INTEGER);
  const live = listTraps();
  // Historical traps: a stowed or ghosted registration is gone, but its mail
  // dir, notices, and delivery receipts survive — list those ids too so a
  // seat's story stays inspectable after sign-off.
  const liveIds = new Set(live.map((t) => t.trapId));
  const seenIds = new Set<string>();
  for (const f of listDir(laneDirs('work').inbox)) {
    const m = /^trap-(.+)$/.exec(f);
    if (m?.[1]) seenIds.add(m[1]);
  }
  for (const x of dispatches) {
    for (const v of [x.claimedBy, x.evidence?.deliveredTo, x.for]) {
      if (typeof v === 'string' && v.startsWith('wt:')) seenIds.add(v.slice(3));
    }
  }
  for (const n of allNotices) {
    if (n.kind.startsWith('trap-') && n.refId) seenIds.add(n.refId);
  }
  const names = trapNamer();
  const attach = (t: GlassTrap, registered: boolean, listening = false): GlassTrap => {
    const notices = allNotices.filter((n) => n.refId === t.trapId).reverse();
    const signed = notices.find((n) => n.kind === 'trap-signed-on');
    const name = t.name ?? names(t.trapId);
    return {
      ...t,
      name,
      label: trapLabel({ trapId: t.trapId, name }),
      link: validSessionLink(t.link) ? t.link : undefined,
      sessionId: t.sessionId ?? signed?.by,
      harness: t.harness ?? (/\((claude|codex),/.exec(signed?.text ?? '')?.[1]),
      live: registered,
      listening,
      messages: trapMessages(t.trapId),
      notices,
      catches: dispatches.filter(
        (x) => x.claimedBy === `wt:${t.trapId}` || x.evidence?.deliveredTo === `wt:${t.trapId}` || x.for === `wt:${t.trapId}`,
      ),
    };
  };
  const traps = [
    ...live.map((t) => attach(t as GlassTrap, true, !!t.firstParkedAt && Date.now() - trapLastSeen(t) <= loadConfig().soak.ttlSecs * 1000)),
    ...[...seenIds].filter((id) => !liveIds.has(id)).sort().map((id) => attach({ trapId: id } as GlassTrap, false)),
  ];
  const attention = attentionSnapshot();
  return {
    now: new Date().toISOString(),
    version: lobstahVersion(),
    repoUrl: REPO_URL,
    daemon: executor ? { version: executor.version, heartbeat: executor.heartbeat } : undefined,
    slots: { headless: workSlots.headless, limit: loadConfig().limits.maxConcurrent, traps: workSlots.traps, parked: workSlots.parked },
    helms,
    traps,
    trapNames: trapNamesShown(traps, dispatches, attention, names),
    notices: allNotices.slice().reverse(),
    watches,
    dispatches,
    prs,
    stacks,
    ...attention,
    reports: reportRows(),
    mergeView,
    decisions: glassDecisions(),
    answerLimits: {
      maxBytes: attachmentLimit(),
      maxFiles: ANSWER_FILES_MAX,
      textMax: ANSWER_TEXT_MAX,
      extensions: [...ANSWER_EXTENSIONS],
    },
  };
}

/** limits.attachmentMaxBytes; a config error falls back to the default. */
function attachmentLimit(): number {
  try {
    return loadConfig().limits.attachmentMaxBytes;
  } catch {
    return DEFAULT_LIMITS.attachmentMaxBytes;
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A `decision-answer` request's payload, shape-checked: the decision key
 * (or a raw question's `<lane>:<id>`), an option, text, and base64 files.
 * Content checks (the key, the option, sizes, types) are answerKey's,
 * shared with `man answer`.
 */
function decisionAnswerRequest(raw: unknown): { key: string; option?: string; text?: string; uploads: Array<{ name: string; data: Buffer }> } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DecisionError('payload must be an object');
  const body = raw as { key?: unknown; option?: unknown; text?: unknown; files?: unknown };
  const key = typeof body.key === 'string' ? body.key : '';
  if (!/^(decision:[a-f0-9]{8}|(work|chore):[A-Za-z0-9-]{1,64})$/.test(key)) throw new DecisionError('Unknown decision.', 404);
  if (body.option !== undefined && typeof body.option !== 'string') throw new DecisionError('option must be a string');
  if (body.text !== undefined && typeof body.text !== 'string') throw new DecisionError('text must be a string');
  if (body.files !== undefined && !Array.isArray(body.files)) throw new DecisionError('files must be a list');
  const files = (body.files ?? []) as unknown[];
  if (files.length > ANSWER_FILES_MAX) throw new DecisionError(`an answer takes at most ${ANSWER_FILES_MAX} files`, 413);
  const uploads = files.map((f) => {
    const file = f as { name?: unknown; data?: unknown };
    if (typeof file !== 'object' || file === null || typeof file.name !== 'string' || typeof file.data !== 'string' || !BASE64.test(file.data)) {
      throw new DecisionError('each file needs a name and base64 data');
    }
    return { name: file.name, data: Buffer.from(file.data, 'base64') };
  });
  return {
    key,
    ...(body.option !== undefined ? { option: body.option as string } : {}),
    ...(body.text !== undefined ? { text: body.text as string } : {}),
    uploads,
  };
}

/**
 * The page itself: built from apps/cli/glass (index.html, glass.css, and the
 * TypeScript under src/) by scripts/build-glass.mjs into one self-contained
 * HTML string — CSS and JS inlined, nothing else to serve.
 */
const PAGE = GLASS_PAGE;

/** Serve the glass on 127.0.0.1. Returns the listening server. */
export function serveGlass(
  port: number,
  options: { focus?: (reg: TrapRegistration) => Promise<FocusResult> } = {},
): http.Server {
  const focusToken = randomBytes(32).toString('hex');
  const icon = assetPath('favicon.png') ?? assetPath('lob-star.png');
  const lob = assetPath('lob.png');
  const sprite = assetPath('lob-sprite.png');
  const star = assetPath('star.png');
  // A compiled binary carries no asset files; the favicon degrades to the
  // emoji mark instead of a broken tab icon.
  const fallbackIcon = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F99E}</text></svg>`;
  /** Same host, same origin, and this server's page token: the only writes the glass accepts. */
  const ownHost = () => {
    const address = server.address();
    return `127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
  };
  const authorized = (req: http.IncomingMessage, header: string): boolean => {
    const supplied = req.headers[header];
    const token = typeof supplied === 'string' ? supplied : '';
    return (
      req.headers.host === ownHost() &&
      req.headers.origin === `http://${ownHost()}` &&
      token.length === focusToken.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(focusToken))
    );
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Server', `lobstah-glass/${lobstahVersion()}`);
    if (req.url === '/requests') {
      res.setHeader('cache-control', 'no-store');
      const reply = (status: number, result: unknown) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      };
      if (req.method !== 'POST') return reply(405, { ok: false, reason: 'POST required.' });
      if (!authorized(req, 'x-lobstah-token')) {
        req.resume();
        return reply(403, { ok: false, reason: 'Request was not authorized.' });
      }
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
        req.resume();
        return reply(415, { ok: false, reason: 'JSON required.' });
      }
      // A decision answer carries its files as base64, with its text.
      const cap = Math.ceil((attachmentLimit() * 4) / 3) * ANSWER_FILES_MAX + ANSWER_TEXT_MAX * 4 + 64 * 1024;
      if (Number(req.headers['content-length'] ?? NaN) > cap) {
        req.resume();
        return reply(413, { ok: false, reason: 'The request is too large.' });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let refused = false;
      req.on('data', (chunk: Buffer) => {
        if (refused) return;
        size += chunk.length;
        if (size <= cap) return void chunks.push(chunk);
        refused = true;
        chunks.length = 0;
        reply(413, { ok: false, reason: 'The request is too large.' });
      });
      req.on('end', () => {
        if (refused) return;
        let body: { kind?: unknown; payload?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
        } catch {
          return reply(400, { ok: false, reason: 'Invalid JSON.' });
        }
        if (body?.kind !== 'decision-answer') return reply(400, { ok: false, reason: 'Unknown request kind.' });
        try {
          const { key, ...answer } = decisionAnswerRequest(body.payload);
          const { decision, answer: stored } = answerKey(key, { ...answer, by: 'glass' });
          reply(201, { ok: true, id: stored.request, key: decision.key });
        } catch (err) {
          if (err instanceof DecisionError) return reply(err.status, { ok: false, reason: err.message });
          reply(500, { ok: false, reason: 'The answer could not be stored.' });
        }
      });
      req.on('error', () => reply(400, { ok: false, reason: 'The request failed.' }));
      return;
    }
    if (req.url?.startsWith('/api/focus/')) {
      res.setHeader('cache-control', 'no-store');
      const reply = (status: number, result: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      };
      if (req.method !== 'POST') return reply(405, { focused: false, reason: 'POST required.' });
      if (
        !authorized(req, 'x-lobstah-focus-token') ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
        req.headers['transfer-encoding'] !== undefined
      ) {
        return reply(403, { focused: false, reason: 'Focus request was not authorized.' });
      }
      const trapId = req.url.slice('/api/focus/'.length);
      if (!/^[A-Za-z0-9-]{1,64}$/.test(trapId)) return reply(400, { focused: false, reason: 'Invalid trap id.' });
      const reg = liveTrap(trapId);
      if (!reg) return reply(409, { focused: false, reason: 'Trap is not live.' });
      void (options.focus ?? focusRegistration)(reg)
        .then((result) => reply(result.focused ? 200 : 409, result))
        .catch(() => reply(500, { focused: false, reason: 'Window focus failed.' }));
      return;
    }
    if (req.url === '/api/version' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'lobstah-glass', version: lobstahVersion(), pid: process.pid }));
      return;
    }
    if (req.url === '/lob.png' && lob) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
      res.end(fs.readFileSync(lob));
    } else if (req.url === '/star.png' && star) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
      res.end(fs.readFileSync(star));
    } else if (req.url === '/lob-sprite.png' && sprite) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
      res.end(fs.readFileSync(sprite));
    } else if (req.url === '/icon.png') {
      if (icon) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
        res.end(fs.readFileSync(icon));
      } else {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' });
        res.end(fallbackIcon);
      }
    } else if ((req.url?.startsWith('/report/') || req.url?.startsWith('/decision/')) && req.method === 'GET' && serveReport(req.url, res)) {
      return;
    } else if (req.url?.startsWith('/attachment/') && req.method === 'GET' && serveAttachment(req.url, res)) {
      return;
    } else if (req.url === '/data') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...buildGlassSnapshot(), focusToken, focusSupported: process.platform === 'darwin' }));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
