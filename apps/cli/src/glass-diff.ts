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
const STALE_DAEMON_MS=90000,STALE_SEAT_MS=1800000;
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
 return d.traps.find(v=>v.trapId===modal.key)||null}
function sectionInputs(d,ui,now){
 const st=ui.st;
 const seat=(x)=>({x,stale:isStale(x.heartbeatAt,STALE_SEAT_MS,now)});
 const item=modalItem(d,ui.modal);
 return {
  chips:{daemon:d.daemon,daemonStale:!!d.daemon&&isStale(d.daemon.heartbeat,STALE_DAEMON_MS,now),helms:d.helms.map(seat)},
  attention:[...d.dispatches.filter(x=>x.verb==='needs-decision'||x.verb==='blocked').map(x=>({kind:'question',...x})),
   ...(d.prAttention||[]).map(({ageSecs,...a})=>a)],
  dispatches:{view:st.view,open:[...ui.open].sort(),list:d.dispatches.filter(x=>matches(x,st))},
  traps:{view:st.view,list:(st.repo?d.traps.filter(t=>t.repo===st.repo):d.traps).map(seat)},
  notices:st.repo?d.notices.filter(n=>!n.repo||n.repo===st.repo):d.notices,
  merge:d.mergeView,
  watches:d.watches,
  foot:{version:d.version,repoUrl:d.repoUrl},
  modal:{modal:ui.modal,item:item&&seat(item)}}}
function hashInputs(inputs){const out={};
 for(const k of Object.keys(inputs))out[k]=hashStr(stableStringify(inputs[k]));
 return out}
function sectionHashes(d,ui,now){return hashInputs(sectionInputs(d,ui,now))}
function dirtySections(prev,next){return Object.keys(next).filter(k=>!prev||prev[k]!==next[k])}
`;
