import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import { readSettings, settingsStored, validateSettingsPatch, writeSettings } from '@lobstah/core';

/**
 * The spyglass's one write surface: GET/POST /settings over the two runtime
 * settings in ~/.lobstah/settings.json (glass.view, pet.enabled). Everything
 * else the glass serves stays read-only.
 *
 * localhost HTTP is reachable by any webpage, so a write is accepted only
 * when all of these hold (403 otherwise):
 *   1. X-Glass-Token equals the per-launch random token the server embeds in
 *      the page it serves (<meta name="glass-token">). A foreign page cannot
 *      read our page (same-origin policy), so it cannot learn the token; and
 *      a custom header forces a CORS preflight we never answer.
 *   2. Sec-Fetch-Site, when the browser sends it, is same-origin or none.
 *   3. Origin, when present, is this server's own origin.
 *   4. Host names this server on loopback (blunts DNS rebinding).
 * No cookies, no CORS headers — nothing ambient a foreign page could ride.
 */

export const SETTINGS_TOKEN_PLACEHOLDER = '__GLASS_TOKEN__';
const MAX_BODY = 4096;

export function newGlassToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/** The token + fetch-metadata + origin guard for POST /settings. Pure. */
export function checkSettingsWrite(headers: http.IncomingHttpHeaders, token: string, port: number): GuardResult {
  const one = (h: string | string[] | undefined): string | undefined => (Array.isArray(h) ? h[0] : h);
  const sent = one(headers['x-glass-token']);
  if (!sent) return { ok: false, reason: 'missing X-Glass-Token' };
  const a = Buffer.from(sent);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad X-Glass-Token' };
  const site = one(headers['sec-fetch-site']);
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return { ok: false, reason: `cross-site request (Sec-Fetch-Site: ${site})` };
  }
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const origin = one(headers.origin);
  if (origin !== undefined && !allowed.includes(origin)) return { ok: false, reason: `foreign Origin: ${origin}` };
  const host = one(headers.host);
  if (host !== undefined && !allowed.includes(`http://${host}`)) return { ok: false, reason: `foreign Host: ${host}` };
  return { ok: true };
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
};

/**
 * Route /settings. Returns false when the request is not for /settings, so
 * the glass's router falls through to its read-only handlers.
 */
export function handleSettingsRequest(req: http.IncomingMessage, res: http.ServerResponse, token: string, port: number): boolean {
  if ((req.url ?? '').split('?')[0] !== '/settings') return false;
  const stored = { 'x-settings-stored': settingsStored() ? '1' : '0' };
  if (req.method === 'GET' || req.method === 'HEAD') {
    sendJson(res, 200, readSettings(), stored);
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'GET or POST only' }, { allow: 'GET, POST' });
    return true;
  }
  const guard = checkSettingsWrite(req.headers, token, port);
  if (!guard.ok) {
    sendJson(res, 403, { error: guard.reason });
    req.resume();
    return true;
  }
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    sendJson(res, 415, { error: 'content-type must be application/json' });
    req.resume();
    return true;
  }
  let body = '';
  let tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    body += chunk;
    if (body.length > MAX_BODY) tooBig = true;
  });
  req.on('end', () => {
    if (tooBig) return sendJson(res, 413, { error: 'body too large' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: 'body is not JSON' });
    }
    const v = validateSettingsPatch(parsed);
    if (!v.ok) return sendJson(res, 400, { error: v.error });
    sendJson(res, 200, writeSettings(v.patch), { 'x-settings-stored': '1' });
  });
  return true;
}

// ---- page blocks: interpolated into the glass PAGE at delimited spots ----

export const SETTINGS_HEAD = `<meta name="glass-token" content="${SETTINGS_TOKEN_PLACEHOLDER}">`;

export const SETTINGS_CSS = `
#gearbtn{background:none;border:1px solid var(--line);border-radius:6px;color:var(--dim);font:inherit;font-size:13px;padding:1px 7px;margin-left:8px;cursor:pointer;vertical-align:1px}
#gearbtn:hover,#gearbtn.on{color:var(--fg);border-color:#3a455a}
#settingspop{display:none;position:absolute;top:40px;left:16px;z-index:8;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.5);min-width:230px}
#settingspop.open{display:block}
#settingspop .row{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:6px 0}
#settingspop .lbl{color:var(--dim);font-size:12px}
#settingspop .err{color:var(--bad);font-size:11px;min-height:1em}
`;

export const SETTINGS_MARKUP = `<div id="settingspop" role="dialog" aria-label="settings">
 <div class="row"><span class="lbl">view</span><span class="seg" id="viewseg"><button data-v="table">table</button><button data-v="cards">cards</button></span></div>
 <div class="row"><span class="lbl">desktop pet</span><span class="seg" id="petseg"><button data-p="on">on</button><button data-p="off">off</button></span></div>
 <div class="err" id="settingserr"></div>
</div>`;

/**
 * The popover's script. Runs after the main glass script (it uses st, save,
 * tick). The server's document wins; localStorage's view is only a fallback
 * while no settings.json exists yet.
 */
export const SETTINGS_SCRIPT = `<script>
(()=>{
const token=(document.querySelector('meta[name="glass-token"]')||{}).content||'';
const pop=document.getElementById('settingspop'),gear=document.getElementById('gearbtn'),err=document.getElementById('settingserr');
let settings=null;
function paint(){if(!settings)return;
 for(const b of document.querySelectorAll('#petseg button'))b.classList.toggle('on',(b.dataset.p==='on')===settings.pet.enabled)}
function adopt(s,stored){settings=s;
 if(stored&&st.view!==s.glass.view){st.view=s.glass.view;save();tick(true)}
 paint()}
async function load(){try{const r=await fetch('/settings',{cache:'no-store'});
 adopt(await r.json(),r.headers.get('x-settings-stored')==='1')}catch(e){}}
window.postSettings=async(patch)=>{err.textContent='';
 try{const r=await fetch('/settings',{method:'POST',headers:{'content-type':'application/json','x-glass-token':token},body:JSON.stringify(patch)});
  const j=await r.json();if(!r.ok){err.textContent=j.error||('error '+r.status);return}
  adopt(j,true)}catch(e){err.textContent='settings write failed'}};
window.setGlassView=(v)=>postSettings({glass:{view:v}});
document.getElementById('petseg').addEventListener('click',(e)=>{const p=e.target.dataset&&e.target.dataset.p;if(p)postSettings({pet:{enabled:p==='on'}})});
gear.addEventListener('click',(e)=>{e.stopPropagation();const o=pop.classList.toggle('open');gear.classList.toggle('on',o);if(o)load()});
document.addEventListener('click',(e)=>{if(!pop.contains(e.target)&&e.target!==gear){pop.classList.remove('open');gear.classList.remove('on')}});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape'){pop.classList.remove('open');gear.classList.remove('on')}});
load();setInterval(load,5000);
})();
</script>`;
