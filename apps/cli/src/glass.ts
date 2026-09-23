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
  readPrs,
} from '@lobstah/core';
import type { Attachment, Descriptor, Lane, Notice } from '@lobstah/core';
import type { TendAttention } from './tend.js';
import { readMergeView } from '@lobstah/pick';
import { lobItems } from './glass-lobs.js';
import { buildTendReport, landedAttention } from './tend.js';
import { GLASS_DIFF_JS } from './glass-diff.js';
import { deriveGlassPrs } from './glass-prs.js';

/**
 * The spyglass: a read-only localhost dashboard over ~/.lobstah — the same
 * observational stance as `man tend`, with room for detail a terminal
 * can't afford. It binds 127.0.0.1 only, never writes lobstah state, and
 * never advances any cursor: looking through the glass consumes nothing.
 * Look freely, steer only from the helm — links out are copyable commands,
 * never exec endpoints (localhost HTTP is reachable by any webpage). The
 * ⚙ popover's two preferences (view, lobs) are the viewing browser's own,
 * kept in its localStorage — the server has nothing to write.
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

interface GlassMessage {
  file: string;
  state: 'pending' | 'delivered';
  from: string;
  at: string;
  text: string;
  attachments?: Attachment[];
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

function dispatchRows() {
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
        verb: last?.verb ?? 'unknown',
        note: last?.note,
        verbAt: last?.at,
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
function attentionSnapshot(): { attention: TendAttention[]; landed: TendAttention[]; attentionKinds: string[]; attentionError?: string } {
  try {
    const cfg = loadConfig();
    return { attention: buildTendReport().attention, landed: landedAttention(cfg, Date.now()), attentionKinds: cfg.attentionKinds };
  } catch (err) {
    return { attention: [], landed: [], attentionKinds: [], attentionError: err instanceof Error ? err.message : String(err) };
  }
}

/** One disk pass, everything the page renders. Pure read. */
export function buildGlassSnapshot() {
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
  const attach = (t: { trapId: string; repo?: string; worktree?: string; harness?: string; sessionId?: string }, liveNow: boolean) => ({
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>spyglass</title>
<link rel="icon" type="image/png" href="/icon.png">
<style>
:root{--bg:#0e1116;--card:#161b22;--line:#2b3240;--fg:#dbe2ea;--dim:#8b96a5;--ok:#4fc17c;--warn:#e2b93d;--bad:#e26d5c;--link:#6cb2e2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding-block:14px;padding-inline:16px}
h1{font-size:15px;margin:0 0 10px}h1 .dim{color:var(--dim);font-weight:normal}
h2{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:20px 0 6px}
.chips,.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.chips{margin-bottom:8px}
.chip{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:3px 9px}
.controls select,.controls input{background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--fg);font:inherit;padding:4px 8px}
.controls input{flex:1 1 140px;min-width:120px;max-width:340px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:8px 0 10px}
.tabs a{color:var(--dim);padding:6px 11px;border-bottom:2px solid transparent}
.tabs a.on{color:var(--fg);border-color:var(--link)}
.tabpage{display:none}.tabpage.on{display:block}
.headerline{display:flex;align-items:center;gap:8px}.headerline h1{flex:1}
#settings-slot{min-width:34px;text-align:right;color:var(--dim)}
#settings-slot #gearbtn{margin-left:0}
#settingspop{left:auto;right:16px}
.deckgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px}
.deckgrid h2{margin:5px 0}.deckgrid section{min-width:0}
.deckline{padding:2px 0;border-top:1px solid var(--line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deckline.acked{opacity:.55}.deckmore{color:var(--dim);font-size:11px}
@media(max-width:700px){.deckgrid{grid-template-columns:1fr}}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.seg button{background:var(--card);border:none;color:var(--dim);font:inherit;padding:4px 11px;cursor:pointer}
.seg button.on{background:#26436b;color:var(--fg)}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden}
th,td{text-align:left;padding:4px 9px;border-top:1px solid var(--line);vertical-align:top;white-space:nowrap}
td.grow{white-space:normal;word-break:break-word;min-width:140px}
th{color:var(--dim);font-weight:normal;border-top:none;font-size:11px}
tr.rowhead{cursor:pointer}tr.rowhead:hover{background:#1c2330}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;cursor:pointer}
.card:hover{border-color:#3a455a}
.card .top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.card .meta{color:var(--dim);font-size:12px;margin-top:2px}
.card .note{margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card .foot{margin-top:8px;display:flex;gap:10px;flex-wrap:wrap;color:var(--dim);font-size:12px}
.badge{border-radius:5px;padding:1px 7px;font-size:11px;border:1px solid var(--line)}
.v-done{color:var(--ok)}.v-working{color:var(--fg)}.v-needs-decision,.v-blocked{color:var(--bad);font-weight:bold}
.v-failed{color:var(--bad)}.v-paused,.v-unknown{color:var(--dim)}
.dim{color:var(--dim)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.detail{display:none}.detail.open{display:table-row}.detail td{background:#10151c;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--dim)}
.detail b{color:var(--fg)}
.empty{color:var(--dim);padding:6px 2px}
#stale{display:none;color:var(--bad)}
a{color:var(--link);text-decoration:none}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
#overlay{position:fixed;inset:0;background:rgba(4,7,11,.72);display:none;z-index:10;padding:28px 16px;overflow:auto}
#overlay.open{display:block}
.modal{max-width:780px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;position:relative}
.modal .x{position:absolute;top:8px;right:12px;cursor:pointer;color:var(--dim);font-size:18px;line-height:1}
.modal .x:hover{color:var(--fg)}
.modal h3{margin:0 24px 2px 0;font-size:14px}
.modal .sub{color:var(--dim);font-size:12px;margin-bottom:10px}
.modal .sec{color:var(--dim);text-transform:uppercase;letter-spacing:.08em;font-size:11px;margin:14px 0 4px}
.modal pre{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit;color:var(--fg)}
.msg{border-left:3px solid var(--line);padding:3px 10px;margin:8px 0;white-space:pre-wrap;word-break:break-word}
.msg.from-helm{border-color:var(--link)}
.msg .hdr{color:var(--dim);font-size:11px}
.catch{border:1px solid var(--line);border-radius:6px;padding:6px 10px;margin:8px 0}
.catch .hdr{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}
.loglines{color:var(--dim);font-size:12px;white-space:pre-wrap;word-break:break-word;margin-top:4px}
.cmd{display:flex;gap:8px;align-items:center;margin:5px 0;flex-wrap:wrap}
.cmd code{background:#10151c;border:1px solid var(--line);border-radius:5px;padding:3px 8px;word-break:break-all;cursor:pointer}
.cmd code:hover{border-color:#3a455a}
.cmd code.copied{border-color:var(--ok)}
.cmd button{background:var(--card);border:1px solid var(--line);border-radius:5px;color:var(--dim);font:inherit;font-size:11px;padding:2px 8px;cursor:pointer}
.cmd button:hover{color:var(--fg)}
.chip.click{cursor:pointer}.chip.click:hover{border-color:#3a455a}
footer{margin-top:26px;padding-top:10px;border-top:1px solid var(--line);color:var(--dim);font-size:12px;display:flex;gap:8px;flex-wrap:wrap}
.lob{position:fixed;bottom:6px;left:0;z-index:5;cursor:pointer;font-size:34px;line-height:1;user-select:none;animation:crawl 18s linear infinite}
a.lob{color:inherit}
.lob .bub .badge{display:inline-block;margin:0 0 3px}
.lob .sprite{width:72px;height:56px;background:url(/lob-sprite.png) 0 0 no-repeat;background-size:400% 100%;image-rendering:pixelated;animation:step .5s steps(4) infinite}
.lob .fallback{display:inline-block;animation:waddle .45s ease-in-out infinite alternate}
.lob .bub{display:none;position:absolute;bottom:58px;right:-8px;z-index:2;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:6px 9px 5px;font-size:11px;line-height:1.35;color:var(--fg);width:max-content;max-width:150px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.lob:hover .bub{display:block}
.lob .bub span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;word-break:break-word}
.lob .star{position:absolute;left:56px;top:-9px;height:14px;image-rendering:pixelated;z-index:3}
.lob:hover{animation-play-state:paused}
@keyframes crawl{0%{transform:translateX(-90px)}100%{transform:translateX(100vw)}}
@keyframes step{to{background-position-x:-288px}}
@keyframes waddle{from{transform:rotate(-8deg) translateY(0)}to{transform:rotate(8deg) translateY(-3px)}}
#gearbtn{background:none;border:1px solid var(--line);border-radius:6px;color:var(--dim);font:inherit;font-size:13px;padding:1px 7px;margin-left:8px;cursor:pointer;vertical-align:1px}
#gearbtn:hover,#gearbtn.on{color:var(--fg);border-color:#3a455a}
#settingspop{display:none;position:absolute;top:40px;left:16px;z-index:8;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.5);min-width:230px}
#settingspop.open{display:block}
#settingspop .row{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:6px 0}
#settingspop .lbl{color:var(--dim);font-size:12px}
#settingspop .hint{display:block;font-size:10px;opacity:.75}
</style></head><body>
<div class="headerline"><h1>🦞✨ spyglass<span id="stale"> · STALE FEED</span></h1><span id="settings-slot"><button id="gearbtn" title="settings" aria-label="settings">⚙</button></span></div>
<div id="settingspop" role="dialog" aria-label="settings (this browser only)">
 <div class="row" id="viewrow"><span class="lbl">view</span><span class="seg" id="viewseg"><button data-v="table">table</button><button data-v="cards">cards</button></span></div>
 <div class="row"><span class="lbl">lobs<span class="hint">crawling lobsters in this page</span></span><span class="seg" id="lobseg"><button data-l="on">on</button><button data-l="off">off</button></span></div>
 <div class="row"><span class="lbl">attention<span class="hint">kinds shown — attentionKinds in config.toml</span></span><span id="attnkinds" class="dim" style="font-size:11px;text-align:right;max-width:190px"></span></div>
</div>
<div class="chips"><span id="chips" style="display:contents"></span><span class="chip dim" id="clock"></span></div>
<nav class="tabs" id="tabs" aria-label="Spyglass views"><a href="#deck" data-tab="deck">On deck</a><a href="#dispatches" data-tab="dispatches">Dispatches</a><a href="#traps" data-tab="traps">Traps</a><a href="#prs" data-tab="prs">PRs</a><a href="#notices" data-tab="notices">Notices</a></nav>
<div class="controls">
 <select id="f-lane"><option value="">all lanes</option><option value="work">work</option><option value="chore">chore</option></select>
 <select id="f-repo"><option value="">all repos</option></select>
 <select id="f-verb"><option value="">all verbs</option><option>working</option><option>needs-decision</option><option>blocked</option><option>paused</option><option>done</option><option>failed</option><option>unknown</option></select>
 <label id="chain-control"><input id="f-chain" type="checkbox"> group by chain</label>
 <select id="f-kind"><option value="">all notice kinds</option></select>
 <input id="f-q" type="search" placeholder="search id · note · brief">
</div>
<main id="page-deck" class="tabpage"><div id="deck"></div></main>
<main id="page-dispatches" class="tabpage"><div id="dispatches"></div></main>
<main id="page-traps" class="tabpage"><div id="traps"></div></main>
<main id="page-prs" class="tabpage"><div id="prs"></div></main>
<main id="page-notices" class="tabpage"><div id="notices"></div></main>
<footer id="foot"></footer>
<div id="lobs"></div>
<div id="overlay"><div class="modal" id="modalbox"></div></div>
<script>
const esc=(s)=>String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const age=(iso)=>{if(!iso)return '';const s=Math.max(0,(Date.now()-Date.parse(iso))/1000);
 if(s<90)return Math.round(s)+'s';if(s<5400)return Math.round(s/60)+'m';if(s<172800)return (s/3600).toFixed(1)+'h';return Math.round(s/86400)+'d'};
// Ages tick in place (refreshAges) so a quiet section never needs a rewrite.
const ageEl=(iso)=>'<span data-age="'+esc(iso)+'">'+age(iso)+'</span>';
function refreshAges(){for(const el of document.querySelectorAll('[data-age]')){const t=age(el.dataset.age);if(el.textContent!==t)el.textContent=t}}
${GLASS_DIFF_JS}const open=new Set();
let modal=null;
let st={view:'table',lane:'',repo:'',verb:'',q:'',lobs:true,chain:false,noticeKind:''};
try{Object.assign(st,JSON.parse(localStorage.getItem('spyglass')||'{}'))}catch(e){}
// A stored value this page doesn't understand falls back to the default.
if(st.view!=='table'&&st.view!=='cards')st.view='table';
st.lobs=st.lobs!==false;
const save=()=>{try{localStorage.setItem('spyglass',JSON.stringify(st))}catch(e){}};
function table(headers,rows,empty){if(!rows.length)return '<div class="empty">'+empty+'</div>';
 return '<div class="wrap"><table><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr>'+rows.join('')+'</table></div>'}
window.copyCmd=async(el,text)=>{try{await navigator.clipboard.writeText(text)}catch(e){return}
 if(el.tagName==='BUTTON'){el.textContent='✓';setTimeout(()=>{el.textContent='⧉'},1000)}
 else{el.classList.add('copied');setTimeout(()=>el.classList.remove('copied'),1000)}};
function cmdRow(text){const j=JSON.stringify(text).replace(/"/g,'&quot;');
 return '<div class="cmd"><code title="click to copy" onclick="copyCmd(this,'+j+')">'+esc(text)+'</code><button title="copy" onclick="copyCmd(this,'+j+')">⧉</button></div>'}
function attachmentRows(items){return items.map(a=>'<div class="sub">'+esc(a.name)+' · '+esc(a.type)+' · '+esc(a.bytes)+' bytes</div>'+cmdRow(a.path)).join('')}
function detailBody(x){return '<div class="sec">brief</div><pre>'+esc(x.brief)+'</pre>'
 +(x.attachments.length?'<div class="sec">attachments ('+x.attachments.length+')</div>'+attachmentRows(x.attachments):'')
 +(x.messageAttachments.length?'<div class="sec">message attachments ('+x.messageAttachments.length+')</div>'+attachmentRows(x.messageAttachments):'')
 +(x.followUp?'<div class="sec">forks</div><pre>'+esc(x.followUp)+'</pre>':'')
 +'<div class="sec">log</div><div class="loglines">'+(x.log.length?x.log.map(e=>esc(e.at)+'  '+esc(e.verb)+(e.note?'  '+esc(e.note):'')).join('\\n'):'no entries yet')+'</div>'
 +(x.inbox.length?'<div class="sec">inbox</div><div class="loglines">'+x.inbox.map(esc).join('\\n---\\n')+'</div>':'')
 +(x.evidence?'<div class="sec">evidence</div><div class="loglines">'+esc(JSON.stringify(x.evidence))+'</div>':'')}
function tableDetail(x){return '<b>brief</b>\\n'+esc(x.brief)
 +(x.attachments.length?'<div class="sec">attachments ('+x.attachments.length+')</div>'+attachmentRows(x.attachments):'')
 +(x.messageAttachments.length?'<div class="sec">message attachments ('+x.messageAttachments.length+')</div>'+attachmentRows(x.messageAttachments):'')
 +(x.followUp?'\\n<b>forks</b> '+esc(x.followUp):'')
 +'\\n<b>log</b>\\n'+x.log.map(e=>esc(e.at)+'  '+esc(e.verb)+(e.note?'  '+esc(e.note):'')).join('\\n')
 +(x.inbox.length?'\\n<b>inbox</b>\\n'+x.inbox.map(esc).join('\\n---\\n'):'')
 +(x.evidence?'\\n<b>evidence</b> '+esc(JSON.stringify(x.evidence)):'')}
function addrCell(x){return x.for?esc(x.for)+(x.evidence&&x.evidence.deliveredTo?' <span class="ok">✓delivered</span>':' <span class="warn">waiting</span>'):(x.claimedBy?esc(x.claimedBy):'')}
function prCell(x){const url=x.evidence&&(x.evidence.prUrl||x.evidence.pr&&x.evidence.pr.url);if(!url)return '';
 const b=x.prBadge;
 return '<a href="'+esc(url)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">PR</a>'
  +(b?' <span class="badge '+esc(b.tone)+'" title="observed '+esc(b.observedAt)+'">'+esc(b.text)+'</span>':'')
  +(x.prGate?' <span class="badge dim" title="merge gate (pick)">'+esc(x.prGate)+'</span>':'')}
function chainRows(list){if(!st.chain)return list;
 const byId=new Map(list.map(x=>[x.id,x]));
 const root=(x)=>{let at=x,seen=new Set();while(at.followUp&&byId.has(at.followUp)&&!seen.has(at.id)){seen.add(at.id);at=byId.get(at.followUp)}return at.id};
 const groups=new Map();for(const x of list){const k=root(x),g=groups.get(k)||[];g.push(x);groups.set(k,g)}
 return [...groups.values()].sort((a,b)=>b[0].sort-a[0].sort).flatMap(g=>g.sort((a,b)=>a.id===root(a)?-1:b.id===root(b)?1:a.sort-b.sort))}
function dispatchTable(list){return table(['id','lane / bucket','repo','verb','note','age','addressed','pr'],
 chainRows(list).map(x=>{const k=x.lane+':'+x.id;
  return '<tr class="rowhead" onclick="showModal(\\'dispatch\\',\\''+k+'\\')"><td>'+(st.chain&&x.followUp?'<span class="dim">↳ </span>':'')+esc(x.id.slice(0,8))+'</td><td>'+x.lane+' / '+x.bucket+'</td><td>'+esc(x.repo)+'</td><td class="v-'+x.verb+'">'+x.verb+'</td><td class="grow">'+esc((x.note??'').slice(0,90))+'</td><td>'+ageEl(x.verbAt)+'</td><td>'+addrCell(x)+'</td><td>'+prCell(x)+'</td></tr>'}),
 'no dispatches match')}
function dispatchCards(list){if(!list.length)return '<div class="empty">no dispatches match</div>';
 return '<div class="cards">'+list.map(x=>{const k=x.lane+':'+x.id;
  return '<div class="card" onclick="showModal(\\'dispatch\\',\\''+k+'\\')"><div class="top"><b>'+esc(x.id.slice(0,8))+'</b><span class="badge v-'+x.verb+'">'+x.verb+'</span></div>'
  +'<div class="meta">'+esc(x.repo)+' · '+x.lane+' '+x.bucket+' · '+ageEl(x.verbAt)+'</div>'
  +(x.note?'<div class="note">'+esc(x.note)+'</div>':'')
  +'<div class="foot">'+addrCell(x)+' '+prCell(x)+'</div></div>'}).join('')+'</div>'}
// Attention kinds (tend's contract): the short label shown in lobs, the pet, and the table.
const KIND_LABEL={'pr:draft':'draft','pr:review':'review','pr:checks':'checks','pr:ready':'ready',landed:'landed',watch:'watch'};
const KIND_TONE={'pr:review':'bad','pr:checks':'bad','pr:ready':'ok','pr:draft':'dim',watch:'warn'};
const kindLabel=(k)=>KIND_LABEL[k]||'';
const isPrKind=(k)=>typeof k==='string'&&k.startsWith('pr:');
function kindCell(x){
 if(x.kind==='question')return '<span class="v-'+x.verb+'">'+x.verb+'</span>';
 const tone=x.kind==='landed'?(x.verb==='failed'?'bad':'ok'):(KIND_TONE[x.kind]||'dim');
 return '<span class="badge '+tone+'">'+esc(kindLabel(x.kind)||x.kind)+'</span>'+(x.kind==='landed'?' <span class="dim">'+esc(x.verb)+'</span>':'')}
function deckBlock(title,rows,tab,max){const shown=rows.slice(0,max),more=rows.length-shown.length;
 return '<section><h2>'+title+'</h2>'+(shown.length?shown.join(''):'<div class="empty">none</div>')
 +(more?'<a class="deckmore" href="#'+tab+'">+'+more+' more →</a>':'')+'</section>'}
function deckLine(body,extra){return '<div class="deckline'+(extra||'')+'">'+body+'</div>'}
function renderDeck(d,inp){const att=inp.attention;
 const byKind=new Map();for(const x of att){const a=byKind.get(x.kind)||[];a.push(x);byKind.set(x.kind,a)}
 const attention=[...byKind].flatMap(([kind,items])=>items.map((x,i)=>deckLine(
  (i===0?'<span class="badge dim">'+esc(kindLabel(kind)||kind)+'</span> ':'')+
  esc(x.repo||'')+' '+esc(x.note||x.verb)+' · '+ageEl(x.at)+
  (x.acked?' · acked '+ageEl(x.acked.at)+' ago':''),x.acked?' acked':'')));
 const flight=inp.inflight.map(x=>deckLine('<b>'+esc(x.id.slice(0,8))+'</b> '+esc(x.repo||'')+' · '+esc(x.note||x.verb)+' · '+ageEl(x.verbAt)+' · '+esc(x.for||x.claimedBy||'')+' '+prCell(x)));
 const landed=inp.landed.map(x=>deckLine('<b>'+esc(x.id.slice(0,8))+'</b> '+esc(x.repo||'')+' · '+esc(x.verb)+' · '+ageEl(x.at)+' '+
  (x.prUrl?'<a href="'+esc(x.prUrl)+'" target="_blank" rel="noopener">PR</a>':'')));
 const traps=inp.traps.map(({x:t})=>deckLine('wt:'+esc(t.trapId)+' · '+esc(t.repo||'')+' · '+(t.live?trapRow(t).listen:'stowed / ghosted')));
 const stacks=inp.stacks.map(s=>{const p=d.prs.find(x=>x.number===s.nextNumber&&x.stackId===s.id);
  return deckLine(s.numbers.map(n=>'#'+n).join(' → ')+' · next: '+(p?'<a href="'+esc(p.url)+'" target="_blank" rel="noopener">#'+p.number+'</a> <span class="badge '+esc(p.badge.tone)+'">'+esc(p.badge.text)+'</span>':'—')+' · '+s.behind+' behind')});
 return '<div class="deckgrid">'+deckBlock('attention',attention,'notices',4)+deckBlock('in flight',flight,'dispatches',4)
  +deckBlock('landed since report',landed,'dispatches',3)+deckBlock('traps',traps,'traps',3)+deckBlock('stacks',stacks,'prs',3)+'</div>'}
function prTable(d,inp){const byStack=new Map();for(const p of inp.prs){const a=byStack.get(p.stackId)||[];a.push(p);byStack.set(p.stackId,a)}
 const rows=[];for(const s of inp.stacks){const prs=byStack.get(s.id)||[];if(!prs.length)continue;
  rows.push('<tr><th colspan="9">'+esc(s.numbers.map(n=>'#'+n).join(' → '))+' · floor '+esc(s.floor)+(s.open?' · open':' · history')+'</th></tr>');
  for(const p of prs){const review=p.review||{};const w=p.watch;
   rows.push('<tr><td><a href="'+esc(p.url)+'" target="_blank" rel="noopener">#'+p.number+'</a></td><td class="grow">'+esc(p.title||'')+'</td>'
    +'<td>'+esc(p.state)+(p.draft?' · draft':'')+'</td><td>'+esc(p.checks.passed)+'/'+esc(p.checks.total)+' passed'+(p.checks.failed?' · '+p.checks.failed+' failed':'')+(p.checks.pending?' · '+p.checks.pending+' pending':'')+'</td>'
    +'<td>'+esc(p.reviewDecision||'')+(review.unresolvedThreads?' · '+review.unresolvedThreads+' unresolved':'')+(review.changesRequested?' · changes requested':'')+'</td>'
    +'<td>'+esc(p.mergeStateStatus)+' · '+(p.nextMergeable?'<span class="ok">next mergeable</span>':p.blockedBy?'blocked by #'+p.blockedBy:'')+'</td>'
    +'<td class="grow">'+p.dispatchIds.map(id=>esc(id.slice(0,8))).join(' → ')+'</td>'
    +'<td class="grow">'+(w?esc(w.cursor)+' · '+(w.lastCheckedAt?ageEl(w.lastCheckedAt)+' ago':'never checked'):'')+'</td><td>'+esc(p.gate||'')+'</td></tr>')}
 }
 const other=table(['key','owner','cursor','last check','error'],inp.watches.map(w=>'<tr><td>'+esc(w.key)+'</td><td>'+esc(w.owner)+'</td><td>'+esc(w.cursor)+'</td><td>'+(w.lastCheckedAt?ageEl(w.lastCheckedAt):'')+'</td><td>'+esc(w.lastError||'')+'</td></tr>'),'no other watches');
 return table(['PR','title','state','checks','review','merge','dispatch chain','watch','gate'],rows,'no PR evidence')+'<h2>other watches</h2>'+other}
function trapRow(t){
 if(!t.live)return {stale:false,listen:'<span class="dot"></span><span class="dim">signed off</span>',hb:'<span class="dim">—</span>'};
 const stale=Date.now()-Date.parse(t.heartbeatAt)>1800000;
 return {stale,listen:t.firstParkedAt?'<span class="dot ok"></span>listening':'<span class="dot warn"></span>never parked',
  hb:'<span class="'+(stale?'bad':'ok')+'">'+(stale?'stale ':'')+ageEl(t.heartbeatAt)+' ago</span>'}}
function mailCell(t){const p=t.messages.filter(m=>m.state==='pending').length;
 return t.messages.length?('✉ '+t.messages.length+(p?' <span class="warn">('+p+' pending)</span>':'')):''}
function trapTable(list){return table(['address','repo','worktree','harness','session','listening','heartbeat','mail','catches'],
 list.map(t=>{const r=trapRow(t);
  return '<tr class="rowhead'+(t.live?'':' dim')+'" onclick="showModal(\\'trap\\',\\''+esc(t.trapId)+'\\')"><td><b>wt:'+esc(t.trapId)+'</b></td><td>'+esc(t.repo??'—')+'</td><td class="grow">'+esc(t.worktree??'')+'</td><td>'+esc(t.harness??'')+'</td><td>'+esc((t.sessionId??'').slice(0,8))+'</td><td>'+r.listen+'</td><td>'+r.hb+'</td><td>'+mailCell(t)+'</td><td>'+t.catches.length+'</td></tr>'}),
 'no traps soaking')}
function trapCards(list){if(!list.length)return '<div class="empty">no traps soaking</div>';
 return '<div class="cards">'+list.map(t=>{const r=trapRow(t);
  return '<div class="card'+(t.live?'':' dim')+'" onclick="showModal(\\'trap\\',\\''+esc(t.trapId)+'\\')"><div class="top"><b>🪤 wt:'+esc(t.trapId)+'</b><span class="badge">'+esc(t.harness??(t.live?'':'signed off'))+'</span></div>'
  +'<div class="meta">'+esc(t.repo??(t.live?'addressed bait only':'history'))+(t.sessionId?' · session '+esc(t.sessionId.slice(0,8)):'')+'</div>'
  +(t.worktree?'<div class="note">'+esc(t.worktree)+'</div>':'')
  +'<div class="foot">'+r.listen+(t.live?' · heartbeat '+r.hb:'')+' · '+t.catches.length+' catch'+(t.catches.length===1?'':'es')+(mailCell(t)?' · '+mailCell(t):'')+'</div></div>'}).join('')+'</div>'}
function renderModal(d){
 const box=document.getElementById('modalbox');
 const ov=document.getElementById('overlay');
 if(!modal){ov.classList.remove('open');return}
 const item=modalItem(d,modal);
 if(!item){modal=null;ov.classList.remove('open');return}
 let html='';
 if(modal.type==='helm'){
  const h=item;
  const stale=Date.now()-Date.parse(h.heartbeatAt)>1800000;
  html='<span class="x" onclick="closeModal()">×</span><h3>⛵ '+esc(h.man)+'</h3>'
   +'<div class="sub">helm of <b>'+esc(h.grounds)+'</b> ('+(h.repos||[]).map(esc).join(', ')+')</div>'
   +'<div class="sub">'+esc(h.harness??'?')+' · '+esc(h.cwd??'?')+(h.host?' · '+esc(h.host):'')+'</div>'
   +'<div class="sub">session '+esc(h.sessionId??'')+' · signed on '+ageEl(h.signedOnAt)+' ago · heartbeat <span class="'+(stale?'warn':'ok')+'">'+ageEl(h.heartbeatAt)+' ago</span></div>'
   +(h.sessionId?'<div class="sec">open this session</div>'+cmdRow((h.harness==='codex'?'codex resume ':'claude --resume ')+h.sessionId):'')
   +(h.transcript?'<div class="sec">transcript</div>'+cmdRow(h.transcript):'');
 }else if(modal.type==='dispatch'){
  const x=item;
  html='<span class="x" onclick="closeModal()">×</span><h3>'+esc(x.id.slice(0,8))+' <span class="badge v-'+x.verb+'">'+x.verb+'</span></h3>'
   +'<div class="sub">'+esc(x.repo)+' · '+x.lane+' '+x.bucket+' · '+ageEl(x.verbAt)+(x.for?' · '+addrCell(x):'')+' '+prCell(x)+'</div>'
   +(x.claimedBy&&x.claimedBy.startsWith('wt:')
     ?'<div class="sec">worked by trap</div>'+cmdRow(x.claimedBy)
      +'<div class="dim" style="font-size:11px">an opted-in interactive session mans this seat — attach would resume someone\\'s live thread. Message it instead: lobstah send '+esc(x.claimedBy)+' "…"</div>'
     :'<div class="sec">open this session</div>'+cmdRow('lobstah attach '+x.id))
   +(x.transcript?'<div class="sec">transcript</div>'+cmdRow(x.transcript):'')
   +detailBody(x);
 }else{
  const t=item;
  const r=trapRow(t);
  html='<span class="x" onclick="closeModal()">×</span><h3>🪤 wt:'+esc(t.trapId)+' <span class="badge">'+esc(t.harness??'signed off')+'</span></h3>'
   +(t.worktree?'<div class="sub">'+esc(t.worktree)+'</div>':'')
   +'<div class="sub">'+(t.live
     ?esc(t.repo??'addressed bait only')+' · session '+esc(t.sessionId??'')+' · signed on '+ageEl(t.signedOnAt)+' ago · '+r.listen+' · heartbeat '+r.hb
     :'signed off — registration gone; the lifecycle, messages, and catches are the surviving record. Re-soaking the same worktree restores this address.')+'</div>'
   +(t.live&&t.sessionId?'<div class="sec">open this session</div>'
     +cmdRow((t.harness==='codex'?'codex resume ':'claude --resume ')+t.sessionId)
     +'<div class="dim" style="font-size:11px">as registered at sign-on — a hookless enlistment may hold a made-up id</div>':'')
   +'<div class="sec">lifecycle ('+t.notices.length+')</div>'
   +(t.notices.length?t.notices.map(n=>'<div class="loglines">'+ageEl(n.at)+' ago · <b>'+esc(n.kind)+'</b> — '+esc(n.text)+'</div>').join(''):'<div class="empty">none recorded</div>')
   +'<div class="sec">messages ('+t.messages.length+')</div>'
   +(t.messages.length?t.messages.map(m=>'<div class="msg'+(m.from==='helm'?' from-helm':'')+'"><div class="hdr">from '+esc(m.from)+' · '+(m.at?ageEl(m.at)+' ago':'')+' · '+(m.state==='pending'?'<span class="warn">pending</span>':'<span class="ok">delivered</span>')+'</div>'+esc(m.text)+(m.attachments?.length?attachmentRows(m.attachments):'')+'</div>').join(''):'<div class="empty">none</div>')
   +'<div class="sec">catches ('+t.catches.length+')</div>'
   +(t.catches.length?t.catches.map(c=>'<div class="catch"><div class="hdr"><b>'+esc(c.id.slice(0,8))+'</b><span class="badge v-'+c.verb+'">'+c.verb+'</span><span class="dim">'+ageEl(c.verbAt)+'</span>'+prCell(c)+'</div>'
     +'<div class="loglines">'+c.log.map(e=>esc(e.at)+'  '+esc(e.verb)+(e.note?'  '+esc(e.note):'')).join('\\n')+'</div></div>').join(''):'<div class="empty">none yet</div>');
 }
 // The overlay is the scroll container; keep the reader's place across a rebuild.
 const top=ov.scrollTop,boxTop=box.scrollTop;
 box.innerHTML=html;ov.classList.add('open');
 ov.scrollTop=top;box.scrollTop=boxTop;
}
// Rewrite one section, keeping any horizontal/vertical scroll inside it.
function setHTML(id,html){const el=document.getElementById(id);
 const sc=[...el.querySelectorAll('.wrap')].map(w=>[w.scrollLeft,w.scrollTop]);
 el.innerHTML=html;
 el.querySelectorAll('.wrap').forEach((w,i)=>{if(sc[i]){w.scrollLeft=sc[i][0];w.scrollTop=sc[i][1]}})}
const setText=(el,t)=>{if(el.textContent!==t)el.textContent=t};
const TABS=GLASS_TABS;
const activeTab=()=>tabFromHash(location.hash);
let hashes={};
// Render only what changed: each section is keyed on a hash of its inputs,
// so a quiet tick touches nothing but ticking ages and the clock.
function render(d){
 const inp=sectionInputs(d,{st,open,modal},Date.now());
 const next=hashInputs(inp);
 const dirty=new Set(dirtySections(hashes,next));
 const tab=activeTab();
 const visible=new Set(visibleSections(tab));
 for(const k of visible)hashes[k]=next[k];
 for(const name of TABS)document.getElementById('page-'+name).classList.toggle('on',name===tab);
 for(const a of document.querySelectorAll('#tabs a'))a.classList.toggle('on',a.dataset.tab===tab);
 document.getElementById('f-lane').style.display=tab==='dispatches'?'':'none';
 document.getElementById('f-verb').style.display=tab==='dispatches'?'':'none';
 document.getElementById('chain-control').style.display=tab==='dispatches'?'':'none';
 document.getElementById('f-kind').style.display=tab==='notices'?'':'none';
 document.getElementById('viewrow').style.display=tab==='dispatches'||tab==='traps'?'':'none';
 // The popover's read-only line: the kinds config.toml selects (#32).
 setText(document.getElementById('attnkinds'),d.attentionError?d.attentionError:(d.attentionKinds||[]).join(' · '));
 setText(document.getElementById('clock'),new Date(d.now).toLocaleTimeString('en-GB'));
 const repos=[...new Set([...d.dispatches.map(x=>x.repo),...d.notices.map(x=>x.repo),...d.prs.map(x=>x.repo)].filter(Boolean))].sort();
 const rsel=document.getElementById('f-repo');
 if(rsel.options.length!==repos.length+1){const cur=st.repo;
  rsel.innerHTML='<option value="">all repos</option>'+repos.map(r=>'<option'+(r===cur?' selected':'')+'>'+esc(r)+'</option>').join('')}
 const kinds=[...new Set(d.notices.map(n=>n.kind))].sort(),ksel=document.getElementById('f-kind');
 if(ksel.options.length!==kinds.length+1)ksel.innerHTML='<option value="">all notice kinds</option>'+kinds.map(k=>'<option'+(k===st.noticeKind?' selected':'')+'>'+esc(k)+'</option>').join('');
 for(const b of document.querySelectorAll('#viewseg button')){const on=b.dataset.v===st.view;if(b.classList.contains('on')!==on)b.classList.toggle('on',on)}
 if(dirty.has('chips')){
  const hbOld=inp.chips.daemonStale;
  setHTML('chips',
   '<span class="chip">daemon '+(d.daemon?('<span class="'+(hbOld?'bad':'ok')+'">'+(hbOld?'stale ':'')+ageEl(d.daemon.heartbeat)+' ago</span> <span class="dim">v'+esc(d.daemon.version)+'</span>'):'<span class="bad">down</span>')+'</span>'
   +inp.chips.helms.map(({x:h,stale})=>
     '<span class="chip click" onclick="showModal(\\'helm\\',\\''+esc(h.grounds)+'\\')">⛵ <b>'+esc(h.man)+'</b> <span class="dim">helm '+esc(h.grounds)+'</span> <span class="'+(stale?'warn':'ok')+'">'+(stale?'stale ':'')+ageEl(h.heartbeatAt)+' ago</span></span>').join(''))}
 if(tab==='deck'&&dirty.has('deck'))setHTML('deck',renderDeck(d,inp.deck));
 if(tab==='dispatches'&&dirty.has('dispatches')){const list=inp.dispatches.list;
  setHTML('dispatches',st.view==='cards'?dispatchCards(list):dispatchTable(list))}
 if(tab==='traps'&&dirty.has('traps')){const traps=inp.traps.list.map(t=>t.x);
  setHTML('traps',st.view==='cards'?trapCards(traps):trapTable(traps))}
 if(tab==='notices'&&dirty.has('notices'))setHTML('notices',table(['at','kind','text','repo'],
  inp.notices.map(n=>'<tr><td class="dim">'+ageEl(n.at)+'</td><td>'+esc(n.kind)+'</td><td class="grow">'+esc(n.text)+'</td><td class="dim">'+esc(n.repo??'')+'</td></tr>'),
  'no notices'));
 if(tab==='prs'&&dirty.has('prs'))setHTML('prs',prTable(d,inp.prs));
 if(dirty.has('foot'))setHTML('foot',
  '🦞✨ lobstah v'+esc(d.version)+' · <a href="'+esc(d.repoUrl)+'" target="_blank">'+esc(d.repoUrl.replace('https://github.com/',''))+'</a>');
 renderLobs(d.attention||[]);
 // The open modal is rebuilt only when its own item (or which one) changed.
 if(dirty.has('modal'))renderModal(d);
 refreshAges();
}
let spriteOk=null;
(()=>{const i=new Image();
 i.onload=()=>{spriteOk=true;lobKey='';tick(true)};
 i.onerror=()=>{spriteOk=false;lobKey='';tick(true)};
 i.src='/lob-sprite.png'})();
let lobKey='';
${lobItems.toString()}
// Per-browser lob hides: {itemKey: stateHash}. localStorage only, guarded like st.
let lobHidden={};
try{lobHidden=JSON.parse(localStorage.getItem('spyglass-lob-hidden')||'{}')||{}}catch(e){lobHidden={}}
window.hideLob=(key,hash)=>{lobHidden[key]=hash;try{localStorage.setItem('spyglass-lob-hidden',JSON.stringify(lobHidden))}catch(e){}lobKey='';setTimeout(()=>tick(true),0)};
const hideCall=(it)=>it.hideKey?"hideLob("+esc(JSON.stringify(it.hideKey)).replace(/'/g,'&#39;')+","+esc(JSON.stringify(it.hideHash))+");":'';
function renderLobs(att){
 // st.lobs gates the lobs; acked items (the pet's shared ack) and lobs this
 // browser already clicked (hidden by item key + state hash) don't walk; a
 // new state re-shows them. lobItems (glass-lobs.ts) makes that decision;
 // the glass writes nothing to lobstah — the hide is localStorage.
 const items=lobItems(att,{lobs:st.lobs,hidden:lobHidden,preview:new URLSearchParams(location.search).has('lob'),
  previewClick:last&&last.helms.length?"showModal('helm','"+last.helms[0].grounds+"')":''});
 const key=items.map(i=>i.key).join('|')+(spriteOk===null?'?':spriteOk?'s':'e');
 if(key===lobKey)return;
 lobKey=key;
 // A PR lob is a plain link out (read-only: the glass opens, never acts);
 // a question lob opens its dispatch modal.
 document.getElementById('lobs').innerHTML=items.map((it,i)=>{
  const style='animation-duration:'+(((innerWidth+180)/(100+i*12)).toFixed(1))+'s;animation-delay:-'+((i*9)%14)+'s';
  const body='<div class="bub">'+(it.label?'<span class="badge dim">'+esc(it.label)+'</span> ':'')+'<span>'+esc(it.text.length>48?it.text.slice(0,47)+'…':it.text)+'</span></div>'
   +(spriteOk===false?'<span class="fallback">🦞</span>':'<div class="sprite"></div>')
   +'<img class="star" src="/star.png" alt="" onerror="this.remove()">';
  return it.href
   ?'<a class="lob" style="'+style+'" title="open the PR" href="'+esc(it.href)+'" target="_blank" rel="noopener" onclick="'+hideCall(it)+'">'+body+'</a>'
   :'<div class="lob" style="'+style+'" title="click to open" onclick="'+hideCall(it)+(it.click||'')+'">'+body+'</div>'}).join('');
}
window.tog=(k)=>{open.has(k)?open.delete(k):open.add(k);tick(true)};
window.showModal=(type,key)=>{modal={type,key};tick(true)};
window.closeModal=()=>{modal=null;if(hashes)hashes.modal=null;document.getElementById('overlay').classList.remove('open')};
document.getElementById('overlay').addEventListener('click',(e)=>{if(e.target.id==='overlay')closeModal()});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeModal()});
document.getElementById('viewseg').addEventListener('click',(e)=>{const v=e.target.dataset&&e.target.dataset.v;if(v){st.view=v;save();tick(true)}});
// The ⚙ popover: per-browser preferences, localStorage only (save()).
const pop=document.getElementById('settingspop'),gear=document.getElementById('gearbtn');
const paintLobs=()=>{for(const b of document.querySelectorAll('#lobseg button'))b.classList.toggle('on',(b.dataset.l==='on')===st.lobs)};
document.getElementById('lobseg').addEventListener('click',(e)=>{const l=e.target.dataset&&e.target.dataset.l;if(l){st.lobs=l==='on';save();paintLobs();tick(true)}});
const closePop=()=>{pop.classList.remove('open');gear.classList.remove('on')};
gear.addEventListener('click',(e)=>{e.stopPropagation();const o=pop.classList.toggle('open');gear.classList.toggle('on',o);paintLobs()});
document.addEventListener('click',(e)=>{if(!pop.contains(e.target)&&e.target!==gear)closePop()});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closePop()});
for(const[id,key]of[['f-lane','lane'],['f-repo','repo'],['f-verb','verb'],['f-kind','noticeKind']]){
 const el=document.getElementById(id);el.value=st[key];
 el.addEventListener('change',()=>{st[key]=el.value;save();tick(true)})}
const chain=document.getElementById('f-chain');chain.checked=!!st.chain;
chain.addEventListener('change',()=>{st.chain=chain.checked;save();tick(true)});
const q=document.getElementById('f-q');q.value=st.q;
q.addEventListener('input',()=>{st.q=q.value;save();tick(true)});
window.addEventListener('hashchange',()=>tick(true));
let last,inflight=false,timer=null;
const setStale=(on)=>{const el=document.getElementById('stale');const v=on?'inline':'none';if(el.style.display!==v)el.style.display=v};
// User-driven ticks render synchronously from last; polls fetch one at a time.
async function tick(rerender){
 if(rerender&&last){render(last);return}
 if(inflight)return;
 inflight=true;
 try{const r=await fetch('/data');last=await r.json();render(last);setStale(false)}
 catch(e){setStale(true)}
 finally{inflight=false}}
const startPoll=()=>{if(!timer)timer=setInterval(()=>tick(false),2000)};
const stopPoll=()=>{clearInterval(timer);timer=null};
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPoll();else{tick(false);startPoll()}});
tick();if(!document.hidden)startPoll();
</script></body></html>`;

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
