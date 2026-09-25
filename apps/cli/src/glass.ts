import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  activeIds,
  executorPath,
  helmLabel,
  laneDirs,
  listHelms,
  listNotices,
  listTraps,
  listWatches,
  loadConfig,
  lobstahVersion,
  pendingIds,
  prBadge,
  readEvidence,
  readSessionClaim,
  readStatusLog,
  queuedAt,
  readPrs,
} from '@lobstah/core';
import type { Attachment, Descriptor, GlassDispatch, GlassMessage, GlassSnapshot, GlassTrap, Lane } from '@lobstah/core';
import type { TendAttention } from './tend.js';
import { readMergeView } from '@lobstah/pick';
import { buildTendReport, landedCatches } from './tend.js';
import type { LandedCatch } from './tend.js';
import { GLASS_PAGE } from './glass-page.generated.js';
import { deriveGlassPrs } from './glass-prs.js';
import { backfillPrWatches } from './pr-watch.js';

/**
 * The spyglass: a read-only localhost dashboard over ~/.lobstah — the same
 * observational stance as `man tend`, with room for detail a terminal
 * can't afford. It binds 127.0.0.1 only; /data may idempotently register
 * missing PR watches, but never advances a cursor or consumes attention.
 * Look freely, steer only from the helm — links out are copyable commands,
 * never exec endpoints (localhost HTTP is reachable by any webpage). The
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
        verb: r.bucket === 'queued' && log.length === 0 ? ('queued' as const) : (last?.verb ?? ('unknown' as const)),
        note: last?.note,
        verbAt: last?.at ?? (r.bucket === 'queued' ? queuedAt(id, r.lane) : undefined),
        claimedBy: claim?.by,
        log,
        inbox: listDir(inboxDir)
          .filter((f) => f.endsWith('.msg'))
          .sort()
          .map((f) => fs.readFileSync(path.join(inboxDir, f), 'utf8').trim()),
        evidence: Object.keys(evidence).length > 0 ? evidence : undefined,
        transcript: transcriptPath(claim?.harness, claim?.worktree, claim?.sessionId),
        sort: r.sort,
      };
    })
    .sort((a, b) => b.sort - a.sort);
}

/**
 * Attention exactly as `man tend` derives it (the one place kinds are
 * decided), plus the active attentionKinds for the read-only line under the
 * heading. A config error surfaces on the page instead of failing /data.
 */
function attentionSnapshot(): { attention: TendAttention[]; landed: LandedCatch[]; attentionKinds: string[]; attentionError?: string } {
  try {
    const cfg = loadConfig();
    return { attention: buildTendReport().attention, landed: landedCatches(cfg), attentionKinds: cfg.attentionKinds };
  } catch (err) {
    return { attention: [], landed: [], attentionKinds: [], attentionError: err instanceof Error ? err.message : String(err) };
  }
}

/** One disk pass, everything the page renders. Pure read. */
export function buildGlassSnapshot(): GlassSnapshot {
  backfillPrWatches();
  const executor = readJson<{ heartbeat?: string; version?: string }>(executorPath());
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
  const watches = listWatches();
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
  const attach = (t: { trapId: string; repo?: string; worktree?: string; harness?: string; sessionId?: string }, liveNow: boolean): GlassTrap => ({
    ...t,
    live: liveNow,
    messages: trapMessages(t.trapId),
    notices: allNotices.filter((n) => n.refId === t.trapId).reverse(),
    catches: dispatches.filter(
      (x) => x.claimedBy === `wt:${t.trapId}` || x.evidence?.deliveredTo === `wt:${t.trapId}` || x.for === `wt:${t.trapId}`,
    ),
  });
  return {
    now: new Date().toISOString(),
    version: lobstahVersion(),
    repoUrl: REPO_URL,
    daemon: executor ? { version: executor.version, heartbeat: executor.heartbeat } : undefined,
    helms,
    traps: [
      ...live.map((t) => attach(t, true)),
      ...[...seenIds].filter((id) => !liveIds.has(id)).sort().map((id) => attach({ trapId: id }, false)),
    ],
    notices: allNotices.slice().reverse(),
    watches,
    dispatches,
    prs,
    stacks,
    ...attentionSnapshot(),
    mergeView,
  };
}

/**
 * The page itself: built from apps/cli/glass (index.html, glass.css, and the
 * TypeScript under src/) by scripts/build-glass.mjs into one self-contained
 * HTML string — CSS and JS inlined, nothing else to serve.
 */
const PAGE = GLASS_PAGE;

/** Serve the glass on 127.0.0.1. Returns the listening server. */
export function serveGlass(port: number): http.Server {
  const icon = assetPath('favicon.png') ?? assetPath('lob-star.png');
  const lob = assetPath('lob.png');
  const sprite = assetPath('lob-sprite.png');
  const star = assetPath('star.png');
  // A compiled binary carries no asset files; the favicon degrades to the
  // emoji mark instead of a broken tab icon.
  const fallbackIcon = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F99E}</text></svg>`;
  const server = http.createServer((req, res) => {
    res.setHeader('Server', `lobstah-glass/${lobstahVersion()}`);
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
    } else if (req.url === '/data') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(buildGlassSnapshot()));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
