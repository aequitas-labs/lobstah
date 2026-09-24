/**
 * The glass page's change detector, as page source. It is plain browser JS
 * inlined into the spyglass's single script (no build step, no deps), and
 * kept here as its own string so tests can evaluate exactly what ships.
 *
 * Each section of the page gets a hash of the inputs it renders from — the
 * snapshot slice, the viewer's filters, and any time-derived flag (stale
 * heartbeats) that changes the markup. Ages ("3m") are not inputs: the page
 * updates those in place as text, so a quiet fleet rewrites nothing.
 *
 * No backslashes or template placeholders below: this lives inside a
 * TypeScript template literal and then inside the page's own script.
 */
export const GLASS_DIFF_JS = `
// On deck's Landed section: the newest LANDED_MAX catches (done or failed)
// within the last LANDED_WINDOW_MS, whatever the report cursor says.
const LANDED_MAX=8,LANDED_WINDOW_MS=86400000;
const STALE_DAEMON_MS=90000,STALE_SEAT_MS=1800000;
// A PR state badge's class: GitHub's state colors (.pr-merged purple,
// .pr-open green, .pr-draft grey, .pr-closed red). An open PR whose badge
// carries news (failed checks, changes requested, pending) keeps that tone.
function prBadgeClass(b){if(!b)return 'dim';const state=b.state||'open';
 return state==='open'&&b.tone&&b.tone!=='ok'?b.tone:'pr-'+state}
const GLASS_TABS=['deck','dispatches','traps','prs','notices'];
function tabFromHash(hash){const tab=String(hash||'').replace(/^#/,'');return GLASS_TABS.includes(tab)?tab:'deck'}
function visibleSections(tab){return ['chips','foot','modal',tabFromHash('#'+tab)]}
function stableStringify(v){
 if(v===null||typeof v!=='object')return v===undefined?'null':JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(stableStringify).join(',')+']';
 return '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+stableStringify(v[k])).join(',')+'}'}
function hashStr(s){let h=0x811c9dc5;
 for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}
 return (h>>>0).toString(36)+':'+s.length}
function isStale(iso,ms,now){return !!iso&&now-Date.parse(iso)>ms}
function matches(x,st){
 if(st.lane&&x.lane!==st.lane)return false;
 if(st.repo&&x.repo!==st.repo)return false;
 if(st.verb&&x.verb!==st.verb)return false;
 if(st.q){const q=st.q.toLowerCase();
  if(!((x.id+' '+(x.note||'')+' '+(x.brief||'')+' '+(x.repo||'')+' '+(x.for||'')).toLowerCase().includes(q)))return false}
 return true}
function modalItem(d,modal){
 if(!modal)return null;
 if(modal.type==='helm')return d.helms.find(v=>v.grounds===modal.key)||null;
 if(modal.type==='dispatch')return d.dispatches.find(v=>v.lane+':'+v.id===modal.key)||null;
 if(modal.type==='pr')return (d.prs||[]).find(v=>v.key===modal.key)||null;
 if(modal.type==='settings')return {attentionKinds:d.attentionKinds||[],attentionError:d.attentionError};
 return d.traps.find(v=>v.trapId===modal.key)||null}
function sectionInputs(d,ui,now){
 const st=ui.st;
 const query=String(st.q||'').toLowerCase();
 const hasQuery=(...parts)=>!query||parts.join(' ').toLowerCase().includes(query);
 const seat=(x)=>({x,stale:isStale(x.heartbeatAt,STALE_SEAT_MS,now)});
 const item=modalItem(d,ui.modal);
 const recent=(iso,ms)=>!!iso&&now-Date.parse(iso)<=ms;
 const deckTraps=(d.traps||[]).filter(t=>(t.live||(t.notices||[]).some(n=>
  (n.kind==='trap-stowed'||n.kind==='trap-ghosted')&&recent(n.at,3600000)))&&hasQuery(t.trapId,t.repo,t.worktree));
 return {
  chips:{daemon:d.daemon,daemonStale:!!d.daemon&&isStale(d.daemon.heartbeat,STALE_DAEMON_MS,now),helms:d.helms.map(seat)},
  deck:{view:st.view,attention:(d.attention||[]).filter(a=>(a.kind==='question'||a.kind==='landed')&&recent(a.at,86400000)&&hasQuery(a.kind,a.repo,a.note,a.id)).map(({ageSecs,...a})=>a),
   prAttention:(d.attention||[]).filter(a=>a.kind&&a.kind.startsWith('pr:')).map(({ageSecs,...a})=>a),
   landed:(d.landed||[]).filter(a=>recent(a.at,LANDED_WINDOW_MS)&&hasQuery(a.repo,a.note,a.id))
    .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,LANDED_MAX),
   inflight:d.dispatches.filter(x=>x.bucket!=='done'&&matches(x,{...st,lane:'',repo:'',verb:''})),traps:deckTraps.map(seat),
   stacks:(d.stacks||[]).filter(s=>s.open&&hasQuery(s.repo,s.numbers.join(' '))),
   prs:(d.prs||[]).filter(p=>p.state==='OPEN'),error:d.attentionError},
  dispatches:{view:st.view,chain:st.chain,list:d.dispatches.filter(x=>matches(x,st))},
  traps:{view:st.view,list:d.traps.filter(t=>(!st.repo||t.repo===st.repo)&&hasQuery(t.trapId,t.repo,t.worktree,t.harness)).map(seat)},
  prs:{view:st.view,stacks:(d.stacks||[]).filter(s=>!st.repo||s.repo===st.repo),
   prs:(d.prs||[]).filter(p=>(!st.repo||p.repo===st.repo)&&hasQuery(p.number,p.title,p.url,p.state,p.baseRefName,p.headRefName)),
   watches:(d.watches||[]).filter(w=>!String(w.key).startsWith('pr:'))},
  notices:{list:(d.notices||[]).filter(n=>(!st.repo||!n.repo||n.repo===st.repo)&&(!st.noticeKind||n.kind===st.noticeKind)&&hasQuery(n.kind,n.text,n.repo))},
  foot:{version:d.version,repoUrl:d.repoUrl},
  // The settings modal re-renders when a preference it shows changes.
  modal:{modal:ui.modal,item:item&&seat(item),prefs:ui.modal&&ui.modal.type==='settings'?{view:st.view,lobs:st.lobs}:undefined}}}
// The PR modal's data: the PR, where it sits in its stack, the dispatch
// chain (linked to their modals when still on disk), and the watch, whose
// cursor is shown only here, never in the PRs table.
function prModalView(d,key){
 const p=(d.prs||[]).find(x=>x.key===key);if(!p)return null;
 const s=(d.stacks||[]).find(x=>x.id===p.stackId);
 const byId=new Map((d.dispatches||[]).map(x=>[x.id,x]));
 const chain=(p.dispatchIds||[]).map(id=>{const x=byId.get(id);
  return x?{id,verb:x.verb,modalKey:x.lane+':'+x.id}:{id,culled:true}});
 const w=p.watch;
 return {pr:p,
  stack:s?{numbers:s.numbers,position:p.position+1,size:s.numbers.length,floor:s.floor,nextNumber:s.nextNumber,
   nextMergeable:!!p.nextMergeable,blockedBy:p.blockedBy}:null,
  chain,
  watch:w?{key:w.key,owner:w.owner||'',lastCheckedAt:w.lastCheckedAt||null,lastError:w.lastError||null,cursor:w.cursor}:null}}
// What the PRs table says about a watch: a short state, never the cursor.
function watchState(w){return w?{text:'watching',at:w.lastCheckedAt||null}:{text:'no watch',at:null}}
function hashInputs(inputs){const out={};
 for(const k of Object.keys(inputs))out[k]=hashStr(stableStringify(inputs[k]));
 return out}
function sectionHashes(d,ui,now){return hashInputs(sectionInputs(d,ui,now))}
function dirtySections(prev,next){return Object.keys(next).filter(k=>!prev||prev[k]!==next[k])}
`;
