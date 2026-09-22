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
  lobstahHome,
  lobstahVersion,
  pendingIds,
  readEvidence,
  readSessionClaim,
  readStatusLog,
} from '@lobstah/core';
import type { Descriptor, Lane, Notice } from '@lobstah/core';
import { readMergeView } from '@lobstah/pick';

/**
 * The spyglass: a read-only localhost dashboard over ~/.lobstah — the same
 * observational stance as `man tend`, with room for detail a terminal
 * can't afford. It binds 127.0.0.1 only, never writes lobstah state, and
 * never advances any cursor: looking through the glass consumes nothing.
 * Look freely, steer only from the helm — links out are copyable commands,
 * never exec endpoints (localhost HTTP is reachable by any webpage).
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

/** A docs/assets file: installed package layout first, repo second. */
function assetPath(name: string): string | undefined {
  for (const rel of [`../docs/assets/${name}`, `../../../../docs/assets/${name}`]) {
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
    try {
      const p = JSON.parse(raw) as { from?: string; at?: string; text?: string };
      return { file: path.basename(file), state, from: p.from ?? 'unknown', at: p.at ?? '', text: p.text ?? '' };
    } catch {
      return { file: path.basename(file), state, from: 'unknown', at: '', text: raw };
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
      .sort((a, b) => b.at - a.at)
      .slice(0, 25);
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

/** One disk pass, everything the page renders. Pure read. */
export function buildGlassSnapshot() {
  const executor = readJson<{ heartbeat?: string; version?: string }>(executorPath());
  const helms = listHelms().map((h) => ({
    ...h,
    session: h.sessionId.slice(0, 8),
    man: helmLabel(h),
    transcript: transcriptPath(h.harness, h.cwd, h.sessionId),
  }));
  const dispatches = dispatchRows();
  const allNotices = listNotices(300);
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
    notices: allNotices.slice(-30).reverse(),
    watches: listDir(path.join(lobstahHome(), 'watches'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<Record<string, unknown>>(path.join(lobstahHome(), 'watches', f)))
      .filter(Boolean),
    dispatches,
    mergeView: readMergeView(),
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
.lob .sprite{width:72px;height:56px;background:url(/lob-sprite.png) 0 0 no-repeat;background-size:400% 100%;image-rendering:pixelated;animation:step .5s steps(4) infinite}
.lob .fallback{display:inline-block;animation:waddle .45s ease-in-out infinite alternate}
.lob .bub{position:absolute;bottom:62px;left:14px;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:6px 9px 5px;font-size:11px;line-height:1.35;color:var(--fg);width:max-content;max-width:130px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.lob .bub span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;word-break:break-word}
.lob .bub img{position:absolute;top:-9px;left:9px;height:16px}
.lob .bub:after{content:'';position:absolute;left:16px;bottom:-5px;width:8px;height:8px;background:var(--card);border-right:1px solid var(--line);border-bottom:1px solid var(--line);transform:rotate(45deg)}
.lob:hover{animation-play-state:paused}
@keyframes crawl{0%{transform:translateX(-90px)}100%{transform:translateX(100vw)}}
@keyframes step{to{background-position-x:-288px}}
@keyframes waddle{from{transform:rotate(-8deg) translateY(0)}to{transform:rotate(8deg) translateY(-3px)}}
</style></head><body>
<h1>🦞✨ spyglass<span id="stale"> · STALE FEED</span></h1>
<div class="chips" id="chips"></div>
<div class="controls">
 <span class="seg" id="viewseg"><button data-v="table">table</button><button data-v="cards">cards</button></span>
 <select id="f-lane"><option value="">all lanes</option><option value="work">work</option><option value="chore">chore</option></select>
 <select id="f-repo"><option value="">all repos</option></select>
 <select id="f-verb"><option value="">all verbs</option><option>working</option><option>needs-decision</option><option>blocked</option><option>paused</option><option>done</option><option>failed</option><option>unknown</option></select>
 <input id="f-q" type="search" placeholder="search id · note · brief">
</div>
<h2>attention</h2><div id="attention"></div>
<h2>dispatches</h2><div id="dispatches"></div>
<h2>traps</h2><div id="traps"></div>
<h2>notices</h2><div id="notices"></div>
<h2>merge view</h2><div id="merge"></div>
<h2>watches</h2><div id="watches"></div>
<footer id="foot"></footer>
<div id="lobs"></div>
<div id="overlay"><div class="modal" id="modalbox"></div></div>
<script>
const esc=(s)=>String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const age=(iso)=>{if(!iso)return '';const s=Math.max(0,(Date.now()-Date.parse(iso))/1000);
 if(s<90)return Math.round(s)+'s';if(s<5400)return Math.round(s/60)+'m';if(s<172800)return (s/3600).toFixed(1)+'h';return Math.round(s/86400)+'d'};
const open=new Set();
let modal=null;
let st={view:'table',lane:'',repo:'',verb:'',q:''};
try{Object.assign(st,JSON.parse(localStorage.getItem('spyglass')||'{}'))}catch(e){}
const save=()=>{try{localStorage.setItem('spyglass',JSON.stringify(st))}catch(e){}};
function table(headers,rows,empty){if(!rows.length)return '<div class="empty">'+empty+'</div>';
 return '<div class="wrap"><table><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr>'+rows.join('')+'</table></div>'}
window.copyCmd=async(el,text)=>{try{await navigator.clipboard.writeText(text)}catch(e){return}
 if(el.tagName==='BUTTON'){el.textContent='✓';setTimeout(()=>{el.textContent='⧉'},1000)}
 else{el.classList.add('copied');setTimeout(()=>el.classList.remove('copied'),1000)}};
function cmdRow(text){const j=JSON.stringify(text).replace(/"/g,'&quot;');
 return '<div class="cmd"><code title="click to copy" onclick="copyCmd(this,'+j+')">'+esc(text)+'</code><button title="copy" onclick="copyCmd(this,'+j+')">⧉</button></div>'}
function detailBody(x){return '<div class="sec">brief</div><pre>'+esc(x.brief)+'</pre>'
 +(x.followUp?'<div class="sec">forks</div><pre>'+esc(x.followUp)+'</pre>':'')
 +'<div class="sec">log</div><div class="loglines">'+(x.log.length?x.log.map(e=>esc(e.at)+'  '+esc(e.verb)+(e.note?'  '+esc(e.note):'')).join('\\n'):'no entries yet')+'</div>'
 +(x.inbox.length?'<div class="sec">inbox</div><div class="loglines">'+x.inbox.map(esc).join('\\n---\\n')+'</div>':'')
 +(x.evidence?'<div class="sec">evidence</div><div class="loglines">'+esc(JSON.stringify(x.evidence))+'</div>':'')}
function tableDetail(x){return '<b>brief</b>\\n'+esc(x.brief)
 +(x.followUp?'\\n<b>forks</b> '+esc(x.followUp):'')
 +'\\n<b>log</b>\\n'+x.log.map(e=>esc(e.at)+'  '+esc(e.verb)+(e.note?'  '+esc(e.note):'')).join('\\n')
 +(x.inbox.length?'\\n<b>inbox</b>\\n'+x.inbox.map(esc).join('\\n---\\n'):'')
 +(x.evidence?'\\n<b>evidence</b> '+esc(JSON.stringify(x.evidence)):'')}
function matches(x){
 if(st.lane&&x.lane!==st.lane)return false;
 if(st.repo&&x.repo!==st.repo)return false;
 if(st.verb&&x.verb!==st.verb)return false;
 if(st.q){const q=st.q.toLowerCase();
  if(!((x.id+' '+(x.note||'')+' '+(x.brief||'')+' '+(x.repo||'')+' '+(x.for||'')).toLowerCase().includes(q)))return false}
 return true}
function addrCell(x){return x.for?esc(x.for)+(x.evidence&&x.evidence.deliveredTo?' <span class="ok">✓delivered</span>':' <span class="warn">waiting</span>'):(x.claimedBy?esc(x.claimedBy):'')}
function prCell(x){return x.evidence&&x.evidence.prUrl?'<a href="'+esc(x.evidence.prUrl)+'" target="_blank" onclick="event.stopPropagation()">PR</a>':''}
function dispatchTable(list){return table(['','id','lane','repo','verb','note','age','addressed','pr'],
 list.map(x=>{const k=x.lane+':'+x.id;const isOpen=open.has(k);
  return '<tr class="rowhead" onclick="tog(\\''+k+'\\')"><td>'+(isOpen?'▾':'▸')+'</td><td>'+esc(x.id.slice(0,8))+'</td><td>'+x.lane+' '+x.bucket+'</td><td>'+esc(x.repo)+'</td><td class="v-'+x.verb+'">'+x.verb+'</td><td class="grow">'+esc((x.note??'').slice(0,90))+'</td><td>'+age(x.verbAt)+'</td><td>'+addrCell(x)+'</td><td>'+prCell(x)+'</td></tr>'
   +'<tr class="detail'+(isOpen?' open':'')+'"><td></td><td colspan="8">'+tableDetail(x)+'</td></tr>'}),
 'no dispatches match')}
function dispatchCards(list){if(!list.length)return '<div class="empty">no dispatches match</div>';
 return '<div class="cards">'+list.map(x=>{const k=x.lane+':'+x.id;
  return '<div class="card" onclick="showModal(\\'dispatch\\',\\''+k+'\\')"><div class="top"><b>'+esc(x.id.slice(0,8))+'</b><span class="badge v-'+x.verb+'">'+x.verb+'</span></div>'
  +'<div class="meta">'+esc(x.repo)+' · '+x.lane+' '+x.bucket+' · '+age(x.verbAt)+'</div>'
  +(x.note?'<div class="note">'+esc(x.note)+'</div>':'')
  +'<div class="foot">'+addrCell(x)+' '+prCell(x)+'</div></div>'}).join('')+'</div>'}
function trapRow(t){
 if(!t.live)return {stale:false,listen:'<span class="dot"></span><span class="dim">signed off</span>',hb:'<span class="dim">—</span>'};
 const stale=Date.now()-Date.parse(t.heartbeatAt)>1800000;
 return {stale,listen:t.firstParkedAt?'<span class="dot ok"></span>listening':'<span class="dot warn"></span>never parked',
  hb:'<span class="'+(stale?'bad':'ok')+'">'+(stale?'stale ':'')+age(t.heartbeatAt)+' ago</span>'}}
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
 let html='';
 if(modal.type==='helm'){
  const h=d.helms.find(v=>v.grounds===modal.key);
  if(!h){modal=null;ov.classList.remove('open');return}
  const stale=Date.now()-Date.parse(h.heartbeatAt)>1800000;
  html='<span class="x" onclick="closeModal()">×</span><h3>⛵ '+esc(h.man)+'</h3>'
   +'<div class="sub">helm of <b>'+esc(h.grounds)+'</b> ('+(h.repos||[]).map(esc).join(', ')+')</div>'
   +'<div class="sub">'+esc(h.harness??'?')+' · '+esc(h.cwd??'?')+(h.host?' · '+esc(h.host):'')+'</div>'
   +'<div class="sub">session '+esc(h.sessionId??'')+' · signed on '+age(h.signedOnAt)+' ago · heartbeat <span class="'+(stale?'warn':'ok')+'">'+age(h.heartbeatAt)+' ago</span></div>'
   +(h.sessionId?'<div class="sec">open this session</div>'+cmdRow((h.harness==='codex'?'codex resume ':'claude --resume ')+h.sessionId):'')
   +(h.transcript?'<div class="sec">transcript</div>'+cmdRow(h.transcript):'');
 }else if(modal.type==='dispatch'){
  const x=d.dispatches.find(v=>v.lane+':'+v.id===modal.key);
  if(!x){modal=null;ov.classList.remove('open');return}
  html='<span class="x" onclick="closeModal()">×</span><h3>'+esc(x.id.slice(0,8))+' <span class="badge v-'+x.verb+'">'+x.verb+'</span></h3>'
   +'<div class="sub">'+esc(x.repo)+' · '+x.lane+' '+x.bucket+' · '+age(x.verbAt)+(x.for?' · '+addrCell(x):'')+' '+prCell(x)+'</div>'
   +(x.claimedBy&&x.claimedBy.startsWith('wt:')
     ?'<div class="sec">worked by trap</div>'+cmdRow(x.claimedBy)
      +'<div class="dim" style="font-size:11px">an opted-in interactive session mans this seat — attach would resume someone\\'s live thread. Message it instead: lobstah send '+esc(x.claimedBy)+' "…"</div>'
     :'<div class="sec">open this session</div>'+cmdRow('lobstah attach '+x.id))
   +(x.transcript?'<div class="sec">transcript</div>'+cmdRow(x.transcript):'')
   +detailBody(x);
 }else{
  const t=d.traps.find(v=>v.trapId===modal.key);
  if(!t){modal=null;ov.classList.remove('open');return}
  const r=trapRow(t);
  html='<span class="x" onclick="closeModal()">×</span><h3>🪤 wt:'+esc(t.trapId)+' <span class="badge">'+esc(t.harness??'signed off')+'</span></h3>'
   +(t.worktree?'<div class="sub">'+esc(t.worktree)+'</div>':'')
   +'<div class="sub">'+(t.live
     ?esc(t.repo??'addressed bait only')+' · session '+esc(t.sessionId??'')+' · signed on '+age(t.signedOnAt)+' ago · '+r.listen+' · heartbeat '+r.hb
     :'signed off — registration gone; the lifecycle, messages, and catches are the surviving record. Re-soaking the same worktree restores this address.')+'</div>'
   +(t.live&&t.sessionId?'<div class="sec">open this session</div>'
     +cmdRow((t.harness==='codex'?'codex resume ':'claude --resume ')+t.sessionId)
     +'<div class="dim" style="font-size:11px">as registered at sign-on — a hookless enlistment may hold a made-up id</div>':'')
   +'<div class="sec">lifecycle ('+t.notices.length+')</div>'
   +(t.notices.length?t.notices.map(n=>'<div class="loglines">'+age(n.at)+' ago · <b>'+esc(n.kind)+'</b> — '+esc(n.text)+'</div>').join(''):'<div class="empty">none recorded</div>')
   +'<div class="sec">messages ('+t.messages.length+')</div>'
   +(t.messages.length?t.messages.map(m=>'<div class="msg'+(m.from==='helm'?' from-helm':'')+'"><div class="hdr">from '+esc(m.from)+' · '+(m.at?age(m.at)+' ago':'')+' · '+(m.state==='pending'?'<span class="warn">pending</span>':'<span class="ok">delivered</span>')+'</div>'+esc(m.text)+'</div>').join(''):'<div class="empty">none</div>')
   +'<div class="sec">catches ('+t.catches.length+')</div>'
   +(t.catches.length?t.catches.map(c=>'<div class="catch"><div class="hdr"><b>'+esc(c.id.slice(0,8))+'</b><span class="badge v-'+c.verb+'">'+c.verb+'</span><span class="dim">'+age(c.verbAt)+'</span>'+prCell(c)+'</div>'
     +'<div class="loglines">'+c.log.map(e=>esc(e.at)+'  '+esc(e.verb)+(e.note?'  '+esc(e.note):'')).join('\\n')+'</div></div>').join(''):'<div class="empty">none yet</div>');
 }
 box.innerHTML=html;ov.classList.add('open');
}
function render(d){
 const hb=d.daemon?age(d.daemon.heartbeat):null;
 const hbOld=d.daemon&&(Date.now()-Date.parse(d.daemon.heartbeat)>90000);
 document.getElementById('chips').innerHTML=
  '<span class="chip">daemon '+(d.daemon?('<span class="'+(hbOld?'bad':'ok')+'">'+(hbOld?'stale ':'')+hb+' ago</span> <span class="dim">v'+esc(d.daemon.version)+'</span>'):'<span class="bad">down</span>')+'</span>'
  +d.helms.map(h=>{const stale=Date.now()-Date.parse(h.heartbeatAt)>1800000;
    return '<span class="chip click" onclick="showModal(\\'helm\\',\\''+esc(h.grounds)+'\\')">⛵ <b>'+esc(h.man)+'</b> <span class="dim">helm '+esc(h.grounds)+'</span> <span class="'+(stale?'warn':'ok')+'">'+(stale?'stale ':'')+age(h.heartbeatAt)+' ago</span></span>'}).join('')
  +'<span class="chip dim">'+new Date(d.now).toLocaleTimeString('en-GB')+'</span>';
 const repos=[...new Set(d.dispatches.map(x=>x.repo).filter(Boolean))].sort();
 const rsel=document.getElementById('f-repo');
 if(rsel.options.length!==repos.length+1){const cur=st.repo;
  rsel.innerHTML='<option value="">all repos</option>'+repos.map(r=>'<option'+(r===cur?' selected':'')+'>'+esc(r)+'</option>').join('')}
 for(const b of document.querySelectorAll('#viewseg button'))b.classList.toggle('on',b.dataset.v===st.view);
 const att=d.dispatches.filter(x=>x.verb==='needs-decision'||x.verb==='blocked');
 document.getElementById('attention').innerHTML=table(['id','repo','verb','question','age'],
  att.map(x=>'<tr><td>'+esc(x.id.slice(0,8))+'</td><td>'+esc(x.repo)+'</td><td class="v-'+x.verb+'">'+x.verb+'</td><td class="grow">'+esc(x.note??'')+'</td><td>'+age(x.verbAt)+'</td></tr>'),
  'nothing needs a human');
 const list=d.dispatches.filter(matches);
 document.getElementById('dispatches').innerHTML=st.view==='cards'?dispatchCards(list):dispatchTable(list);
 const traps=st.repo?d.traps.filter(t=>t.repo===st.repo):d.traps;
 document.getElementById('traps').innerHTML=st.view==='cards'?trapCards(traps):trapTable(traps);
 const notices=st.repo?d.notices.filter(n=>!n.repo||n.repo===st.repo):d.notices;
 document.getElementById('notices').innerHTML=table(['at','kind','text','repo'],
  notices.map(n=>'<tr><td class="dim">'+age(n.at)+'</td><td>'+esc(n.kind)+'</td><td class="grow">'+esc(n.text)+'</td><td class="dim">'+esc(n.repo??'')+'</td></tr>'),
  'no notices');
 const mv=d.mergeView;
 document.getElementById('merge').innerHTML=!mv?'<div class="empty">no merge view (pickup not running)</div>':
  table(['pr','gate','head','uuid'],(mv.open??[]).map(p=>'<tr><td><a href="'+esc(p.url)+'" target="_blank">#'+p.number+'</a></td><td>'+esc(p.gate)+'</td><td class="dim">'+esc(p.headRef)+'</td><td class="dim">'+esc((p.uuid??'').slice(0,8))+'</td></tr>'),'no open PRs')
  +((mv.recent??[]).length?'<div class="dim" style="margin-top:4px">recent: '+mv.recent.map(r=>'#'+r.number+' '+r.disposition).join(' · ')+'</div>':'');
 document.getElementById('watches').innerHTML=table(['key','owner','cursor','last error'],
  d.watches.map(w=>'<tr><td>'+esc(w.key)+'</td><td>'+esc(w.owner)+'</td><td class="dim">'+esc(String(w.cursor??''))+'</td><td class="bad">'+esc(w.lastError??'')+'</td></tr>'),
  'no watches');
 document.getElementById('foot').innerHTML=
  '🦞✨ lobstah v'+esc(d.version)+' · <a href="'+esc(d.repoUrl)+'" target="_blank">'+esc(d.repoUrl.replace('https://github.com/',''))+'</a>';
 renderLobs(att);
 renderModal(d);
}
let spriteOk=null;
(()=>{const i=new Image();
 i.onload=()=>{spriteOk=true;lobKey='';tick(true)};
 i.onerror=()=>{spriteOk=false;lobKey='';tick(true)};
 i.src='/lob-sprite.png'})();
let lobKey='';
function renderLobs(att){
 const preview=new URLSearchParams(location.search).has('lob');
 let items=att.map(x=>({key:x.lane+':'+x.id,text:x.note||x.verb,click:"showModal('dispatch','"+x.lane+':'+x.id+"')"}));
 if(!items.length&&preview)items=[{key:'preview',text:'attention questions crawl in here',click:last&&last.helms.length?"showModal('helm','"+last.helms[0].grounds+"')":''}];
 const extra=items.length>4?items.length-4:0;
 items=items.slice(0,4);
 if(extra)items[3].text='…and '+extra+' more — see attention';
 const key=items.map(i=>i.key).join('|')+(spriteOk===null?'?':spriteOk?'s':'e');
 if(key===lobKey)return;
 lobKey=key;
 document.getElementById('lobs').innerHTML=items.map((it,i)=>
  '<div class="lob" style="animation-duration:'+(((innerWidth+180)/(100+i*12)).toFixed(1))+'s;animation-delay:-'+((i*9)%14)+'s" title="click to open" onclick="'+it.click+'">'
  +'<div class="bub"><img src="/star.png" alt="" onerror="this.replaceWith(String.fromCharCode(0x2728))"><span>'+esc(it.text.length>48?it.text.slice(0,47)+'…':it.text)+'</span></div>'
  +(spriteOk===false?'<span class="fallback">🦞</span>':'<div class="sprite"></div>')
  +'</div>').join('');
}
window.tog=(k)=>{open.has(k)?open.delete(k):open.add(k);tick(true)};
window.showModal=(type,key)=>{modal={type,key};tick(true)};
window.closeModal=()=>{modal=null;document.getElementById('overlay').classList.remove('open')};
document.getElementById('overlay').addEventListener('click',(e)=>{if(e.target.id==='overlay')closeModal()});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeModal()});
document.getElementById('viewseg').addEventListener('click',(e)=>{const v=e.target.dataset&&e.target.dataset.v;if(v){st.view=v;save();tick(true)}});
for(const[id,key]of[['f-lane','lane'],['f-repo','repo'],['f-verb','verb']]){
 const el=document.getElementById(id);el.value=st[key];
 el.addEventListener('change',()=>{st[key]=el.value;save();tick(true)})}
const q=document.getElementById('f-q');q.value=st.q;
q.addEventListener('input',()=>{st.q=q.value;save();tick(true)});
let last;
async function tick(rerender){try{
  if(!rerender||!last){const r=await fetch('/data');last=await r.json()}
  render(last);document.getElementById('stale').style.display='none';
 }catch(e){document.getElementById('stale').style.display='inline'}}
tick();setInterval(()=>tick(false),2000);
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
