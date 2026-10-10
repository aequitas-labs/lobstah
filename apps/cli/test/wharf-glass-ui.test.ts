import { Window } from 'happy-dom';
import { afterEach, expect, it } from 'vitest';
import { GLASS_SCRIPT, GLASS_CSS } from '../../../services/wharf/src/glass-page.generated.js';
import { snapshot, jobs, detail, markdown } from './fixtures/wharf-glass.js';
let windows: Window[] = [];
afterEach(async () => { await Promise.all(windows.map((w) => w.happyDOM.close())); windows = []; });
async function page(path = '/') {
  const window = new Window({ url: 'https://glass.test' + path, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  windows.push(window); const w = window as unknown as Record<string, unknown>;
  const writes: { path: string; body: Record<string, unknown>; headers: Record<string, string>; credentials?: string }[] = [], reads: string[] = [], copied: string[] = [], intervals: (() => void)[] = [];
  let unauthenticated = false;
  w.setInterval = (fn: () => void) => { intervals.push(fn); return intervals.length; }; w.clearInterval = () => {};
  w.fetch = async (path: string, init: RequestInit = {}) => {
    reads.push(path);
    if (unauthenticated) return Response.json({ error: 'sign in' }, { status: 401 });
    if (init.method && init.method !== 'GET') { writes.push({ path, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string>, credentials: init.credentials }); return Response.json({ success: true }); }
    if (path === '/api/glass') return Response.json(snapshot);
    if (path === '/api/glass/dispatches') return Response.json(jobs);
    if (path === '/api/glass/dispatches/job/detail') return Response.json(detail);
    if (path.endsWith('/image') || path.endsWith('/worker-image')) return new Response(new Uint8Array([137, 80, 78, 71]));
    if (path.includes('/files/')) return new Response(markdown);
    if (path.startsWith('/api/auth/device?')) return Response.json({ boatName: 'chris-macbook-2', requestedPermissions: ['work', 'helm'], description: 'Work and steer the helm.' });
    throw new Error('unexpected path ' + path);
  };
  w.TextDecoder = TextDecoder;
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (s: string) => copied.push(s) } });
  const settle = async () => { for (let i = 0; i < 4; i++) { await window.happyDOM.waitUntilComplete(); await new Promise((r) => setTimeout(r, 0)); } };
  window.document.write(`<!doctype html><html><head><style>${GLASS_CSS}</style></head><body><script>${GLASS_SCRIPT}</script></body></html>`); await settle();
  const button = (text: string) => Array.from(window.document.querySelectorAll('button')).find((b) => b.textContent?.includes(text))!;
  const click = async (text: string) => { expect(button(text), text).toBeTruthy(); button(text).click(); await settle(); };
  const tab = async (text: string) => { (window.document.querySelector(`nav a[href='#${text}']`)! as unknown as HTMLElement).click(); await settle(); };
  const input = (label: string, text: string) => { const node = window.document.querySelector(`[aria-label='${label}']`)! as unknown as HTMLInputElement; node.value = text; node.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event); };
  return { window, doc: window.document, writes, reads, copied, settle, click, tab, input, poll: async () => { intervals.forEach((f) => f()); await settle(); }, unauthenticated: () => { unauthenticated = true; } };
}
it('shows jobs, notes, catches, PR links and the remote boat’s copy command without claiming window focus', async () => {
  const g = await page(); expect(g.doc.body.textContent).toContain('waiting for helm'); await g.tab('jobs'); await g.click('Build the hosted spyglass');
  expect(g.doc.body.textContent).toContain('Browser controls'); expect(g.doc.body.textContent).toContain('Waiting for review'); expect(g.doc.body.textContent).toContain('Please preserve local behavior.');
  expect(g.doc.querySelector("a[href='https://github.com/aequitas-labs/lobstah/pull/205']")).toBeTruthy();
  expect(g.doc.body.textContent).toContain('on chris-macbook'); expect(g.doc.body.textContent).toContain('cannot open a remote window');
  expect(g.doc.querySelectorAll('.mdpage').length).toBe(1); expect(g.reads).toContain('/api/glass/dispatches/job/files/worker-md');
  expect(g.reads).toContain('/api/glass/dispatches/job/files/worker-image');
  await g.click('⧉'); expect(g.copied).toEqual(['codex resume test-session']); expect(g.doc.body.textContent).toContain('copied');
  expect(g.doc.querySelectorAll('[role=dialog]').length).toBe(1); await g.click('×'); await g.tab('traps'); expect(g.doc.body.textContent).toContain('codex'); expect(g.doc.body.textContent).toContain('kind-crab');
});
it('renders reports/cards as safe elements and requests only their own attachment images', async () => {
  const g = await page(); await g.click('Choose the next catch');
  const modal = g.doc.querySelector('[role=dialog]')!;
  expect(modal.textContent).toContain('<script>alert(1)</script>'); expect(modal.querySelector('script')).toBeNull(); expect(modal.querySelector("a[href^='javascript:']")).toBeNull();
  expect(g.reads).toContain('/api/glass/documents/card/files/image'); expect(g.reads.some((s) => s.includes('evil') || s.includes('other.png'))).toBe(false);
  await g.click('Keep it small'); g.input('answer', 'Go ahead'); await g.settle(); await g.click('answer card');
  expect(g.writes).toContainEqual(expect.objectContaining({ path: '/api/glass/documents/card/answer', body: { option: 'Keep it small', text: 'Go ahead' } }));
  await g.click('×'); await g.tab('reports'); await g.click('Wharf progress'); expect(g.reads).toContain('/api/glass/documents/report/files/report-md');
});
it('queues messages, confirms direct cancellation, and sends no bearer or helm takeover', async () => {
  const g = await page(); await g.tab('jobs'); await g.click('Build the hosted spyglass'); g.input('message to helm', 'Please retry'); await g.settle(); await g.click('queue message for helm');
  expect(g.writes[0]).toMatchObject({ path: '/api/glass/requests', body: { kind: 'message', dispatch: 'job', text: 'Please retry' }, credentials: 'same-origin' });
  await g.click('cancel job…'); expect(g.writes).toHaveLength(1); await g.click('confirm cancel'); expect(g.writes[1]).toMatchObject({ path: '/api/glass/dispatches/job/cancel', body: {} });
  for (const write of g.writes) { expect(write.headers['Idempotency-Key']).toBeTruthy(); expect(write.headers.Authorization).toBeUndefined(); expect(write.headers['X-Lobstah-Helm']).toBeUndefined(); }
  expect(g.writes.some((w) => w.path.includes('helm/'))).toBe(false);
});
it('boats show repos and check-in, no edit/grant controls; revoke and delete each require confirmation', async () => {
  const g = await page(); await g.tab('boats'); expect(g.doc.body.textContent).toContain('last check-in'); expect(g.doc.body.textContent).toContain('github.com/aequitas-labs/lobstah');
  expect(Array.from(g.doc.querySelectorAll('button')).some((b) => /edit|grant|rename/.test(b.textContent ?? ''))).toBe(false);
  await g.click('revoke…'); expect(g.writes).toHaveLength(0); await g.click('confirm revoke'); expect(g.writes[0].path).toBe('/api/glass/boats/boat/revoke');
  await g.click('request trap…'); await g.click('queue trap request'); expect(g.writes[1]).toMatchObject({ body: { kind: 'trap-request', boat: 'boat', repo: 'github.com/aequitas-labs/lobstah' } });
  await g.click('delete account…'); expect(g.writes).toHaveLength(2); await g.click('confirm delete account'); expect(g.writes[2]).toMatchObject({ path: '/api/glass/account', body: { confirm: true } });
});
it('boat approval shows the resolved name and allows only requested or lower access, never admin', async () => {
  const g = await page('/device?user_code=test-code'); await g.click('inspect request'); expect(g.doc.body.textContent).toContain('chris-macbook-2');
  const select = g.doc.querySelector('[aria-label="approved boat access"]')! as unknown as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.value)).toEqual(['none', 'read', 'helm']); select.value = 'read'; select.dispatchEvent(new g.window.Event('change', { bubbles: true }) as unknown as Event); await g.settle(); await g.click('approve chris');
  expect(g.writes[0]).toMatchObject({ path: '/api/auth/wharf/approve', body: { userCode: 'test-code', name: 'chris-macbook-2', requestedPermissions: ['work', 'helm'], permissions: ['work', 'read'] } });
});
it('an expired cookie clears stale account details and asks for GitHub sign-in', async () => {
  const g = await page(); g.unauthenticated(); await g.poll(); expect(g.doc.body.textContent).toContain('sign in with GitHub'); expect(g.doc.querySelector('nav')).toBeNull(); expect(g.doc.body.textContent).not.toContain('Choose the next catch');
});
it('sign-out stops polling instead of restoring account details on the next interval', async () => {
  const g = await page(); await g.click('sign out'); const reads = g.reads.length; await g.poll();
  expect(g.reads).toHaveLength(reads); expect(g.doc.querySelector('nav')).toBeNull();
  expect(g.doc.body.textContent).not.toContain('Choose the next catch');
});
