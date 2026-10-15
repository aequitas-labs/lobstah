import { Window } from 'happy-dom';
import { afterEach, expect, it } from 'vitest';
import { GLASS_SCRIPT, GLASS_CSS } from '../../../services/wharf/src/glass-page.generated.js';
import { snapshot, jobs, detail, markdown } from './fixtures/wharf-glass.js';
import { parseRoute, routeHash } from '../../../services/wharf/glass/src/route.js';
let windows: Window[] = [];
afterEach(async () => { await Promise.all(windows.map((w) => w.happyDOM.close())); windows = []; });
async function page(path = '/', signedOut = false, data: { snapshot?: typeof snapshot; jobs?: typeof jobs; badge?: (count: number) => Promise<void> } = {}) {
  const window = new Window({ url: 'https://glass.test' + path, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  windows.push(window); const w = window as unknown as Record<string, unknown>;
  const writes: { path: string; body: Record<string, unknown>; headers: Record<string, string>; credentials?: string }[] = [], reads: string[] = [], copied: string[] = [], intervals: (() => void)[] = [];
  let unauthenticated = signedOut;
  const sockets: { url: string; onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; closed: boolean; close(): void }[] = [];
  w.WebSocket = class {
    onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; closed = false;
    constructor(public url: string) { sockets.push(this); }
    close() { this.closed = true; }
  };
  w.setInterval = (fn: () => void) => { intervals.push(fn); return intervals.length; }; w.clearInterval = () => {};
  w.fetch = async (path: string, init: RequestInit = {}) => {
    reads.push(path);
    // Sign-in answers a signed-out page; the fixture sends it back to the same document.
    if (path === '/api/auth/sign-in/social') { writes.push({ path, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string>, credentials: init.credentials }); return Response.json({ url: window.location.href }); }
    if (unauthenticated) return Response.json({ error: 'sign in' }, { status: 401 });
    if (init.method && init.method !== 'GET') { writes.push({ path, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string>, credentials: init.credentials }); return Response.json({ success: true }); }
    if (path === '/api/glass') return Response.json(data.snapshot ?? snapshot);
    if (path === '/api/glass/dispatches') return Response.json(data.jobs ?? jobs);
    if (path === '/api/glass/dispatches/job/detail') return Response.json(detail);
    if (path.endsWith('/image') || path.endsWith('/worker-image')) return new Response(new Uint8Array([137, 80, 78, 71]));
    if (path.includes('/files/')) return new Response(markdown);
    if (path.startsWith('/api/auth/device?')) return Response.json({ boatName: 'chris-macbook-2', requestedPermissions: ['work', 'helm'], description: 'Work and steer the helm.' });
    throw new Error('unexpected path ' + path);
  };
  w.TextDecoder = TextDecoder;
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (s: string) => copied.push(s) } });
  if (data.badge) Object.defineProperty(window.navigator, 'setAppBadge', { value: data.badge });
  const settle = async () => { for (let i = 0; i < 4; i++) { await window.happyDOM.waitUntilComplete(); await new Promise((r) => setTimeout(r, 0)); } };
  window.document.write(`<!doctype html><html><head><style>${GLASS_CSS}</style></head><body><script>${GLASS_SCRIPT}</script></body></html>`); await settle();
  const button = (text: string) => Array.from(window.document.querySelectorAll('button')).find((b) => b.textContent?.includes(text))!;
  const click = async (text: string) => { expect(button(text), text).toBeTruthy(); button(text).click(); await settle(); };
  const tab = async (text: string) => { (window.document.querySelector(`nav a[href='#${text}']`)! as unknown as HTMLElement).click(); await settle(); };
  const input = (label: string, text: string) => { const node = window.document.querySelector(`[aria-label='${label}']`)! as unknown as HTMLInputElement; node.value = text; node.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event); };
  return { window, doc: window.document, writes, reads, copied, sockets, settle, click, tab, input, poll: async () => { intervals.forEach((f) => f()); await settle(); }, unauthenticated: () => { unauthenticated = true; } };
}
it('badges only open account decisions, updates on existing polls, and clears on sign-out', async () => {
  const badges: number[] = [];
  const s = structuredClone(snapshot), card = s.documents[0]!;
  s.documents.push({ ...card, id: 'second' }, { ...card, id: 'answered', answer: { at: card.at, by: 'person', text: 'Yes' } }, { ...card, id: 'withdrawn', withdrawn: true });
  const data = { snapshot: s, badge: async (n: number) => { badges.push(n); } };
  const g = await page('/', false, data); expect(badges.at(-1)).toBe(2);
  const reads = g.reads.length;
  s.documents = s.documents.filter((d) => d.id !== 'second'); await g.poll(); expect(badges.at(-1)).toBe(1);
  expect(g.reads.slice(reads)).toEqual(['/api/glass', '/api/glass/dispatches']);
  s.documents = []; await g.poll(); expect(badges.at(-1)).toBe(0);
  s.documents = [card]; await g.poll(); expect(badges.at(-1)).toBe(1);
  await g.click('sign out'); expect(badges.at(-1)).toBe(0);
});
it('keeps the hosted glass usable when the OS denies app badges', async () => {
  const g = await page('/', false, { badge: async () => { throw new Error('not allowed'); } });
  await g.poll(); expect(g.doc.body.textContent).toContain('Choose the next catch');
});
it('uses a cookie-only wake hint, retains polling on a drop and closes hints on sign-out', async () => {
  const g = await page(); expect(g.sockets).toHaveLength(1); expect(String(g.sockets[0].url)).toBe('wss://glass.test/api/glass/wake');
  const reads = g.reads.length; g.sockets[0].onmessage?.({ data: '{"type":"wake"}' }); await g.settle();
  expect(g.reads.length).toBeGreaterThan(reads);
  g.sockets[0].onclose?.(); await g.poll(); expect(g.sockets).toHaveLength(2);
  await g.click('sign out'); expect(g.sockets[1].closed).toBe(true); await g.poll(); expect(g.sockets).toHaveLength(2);
});
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
it('opens on the decision, report or job its link names, in that item’s view', async () => {
  const decision = await page('/#decision/card');
  expect(decision.doc.querySelector('[role=dialog]')?.textContent).toContain('Choose the next catch'); expect(decision.reads).toContain('/api/glass/documents/card/files/md');
  expect(decision.doc.querySelector('nav a.on')?.textContent).toBe('deck');
  const report = await page('/#report/report');
  expect(report.doc.querySelector('[role=dialog]')?.textContent).toContain('Wharf progress'); expect(report.reads).toContain('/api/glass/documents/report/files/report-md');
  expect(report.doc.querySelector('nav a.on')?.textContent).toBe('reports');
  const job = await page('/#job/job');
  expect(job.doc.querySelector('[role=dialog]')?.textContent).toContain('Browser controls'); expect(job.reads).toContain('/api/glass/dispatches/job/detail');
  expect(job.doc.querySelector('nav a.on')?.textContent).toBe('jobs');
  expect((await page('/#reports')).doc.querySelector('nav a.on')?.textContent).toBe('reports');
});
it('says so when a link names nothing on this wharf, and reads no file for it', async () => {
  for (const hash of ['#decision/withdrawn', '#report/card', '#job/another']) {
    const g = await page('/' + hash); const modal = g.doc.querySelector('[role=dialog]')!;
    expect(modal.textContent, hash).toContain(`No ${hash.slice(1).split('/')[0]} with this id is listed on this wharf`);
    expect(g.reads.some((r) => r.includes('/files/') || r.endsWith('/detail')), hash).toBe(false);
    await g.click('×'); expect(g.doc.querySelector('[role=dialog]')).toBeNull();
  }
  // Anything that is not a view or an item is the deck, with nothing open.
  const g = await page('/#decision/../boats'); expect(g.doc.querySelector('[role=dialog]')).toBeNull(); expect(g.doc.querySelector('nav a.on')?.textContent).toBe('deck');
});
it('keeps the URL on the open item, returns it to the view on close, and follows a link opened in the page', async () => {
  const g = await page(); await g.click('Choose the next catch'); expect(g.window.location.hash).toBe('#decision/card');
  await g.click('×'); expect(g.window.location.hash).toBe('#deck');
  await g.tab('jobs'); await g.click('Build the hosted spyglass'); expect(g.window.location.hash).toBe('#job/job');
  await g.click('×'); expect(g.window.location.hash).toBe('#jobs');
  g.window.location.hash = '#report/report'; g.window.dispatchEvent(new g.window.Event('hashchange')); await g.settle();
  expect(g.doc.querySelector('[role=dialog]')?.textContent).toContain('Wharf progress'); expect(g.doc.querySelector('nav a.on')?.textContent).toBe('reports');
  g.window.location.hash = '#boats'; g.window.dispatchEvent(new g.window.Event('hashchange')); await g.settle();
  expect(g.doc.querySelector('[role=dialog]')).toBeNull(); expect(g.doc.body.textContent).toContain('last check-in');
});
it('carries a link through sign-in: the item waits behind the sign-in button and returns as the callback', async () => {
  const g = await page('/#decision/card', true); expect(g.doc.body.textContent).toContain('sign in with GitHub'); expect(g.doc.querySelector('[role=dialog]')).toBeNull();
  expect(g.window.location.hash).toBe('#decision/card');
  await g.click('sign in with GitHub'); expect(g.writes[0]).toMatchObject({ path: '/api/auth/sign-in/social', body: { provider: 'github', callbackURL: 'https://glass.test/#decision/card' } });
});
it('reads a view or one item from the hash and nothing else', () => {
  expect(parseRoute('#job/abc_DEF-1')).toEqual({ tab: 'jobs', item: { kind: 'job', id: 'abc_DEF-1' } });
  expect(parseRoute('#trap/kind-crab')).toEqual({ tab: 'traps', item: { kind: 'trap', id: 'kind-crab' } });
  expect(parseRoute('#boats')).toEqual({ tab: 'boats' });
  for (const hash of ['', '#', '#job/', '#job/a/b', '#job/a?b', '#job/' + 'a'.repeat(129), '#account/x', '#decision/<script>', '#Deck']) expect(parseRoute(hash), hash).toEqual({ tab: 'deck' });
  for (const hash of ['#deck', '#reports', '#decision/card', '#report/r1']) expect(routeHash(parseRoute(hash))).toBe(hash);
});
it('opening a report acks it once with the page’s cookie; a decision or a job is not acked by looking', async () => {
  const g = await page(); await g.tab('reports'); await g.click('Wharf progress');
  const acks = () => g.writes.filter((w) => w.path.endsWith('/ack'));
  expect(acks()).toEqual([expect.objectContaining({ path: '/api/glass/documents/report/ack', body: {}, credentials: 'same-origin' })]);
  expect(acks()[0]!.headers['Idempotency-Key']).toBeTruthy(); expect(acks()[0]!.headers.Authorization).toBeUndefined();
  // Still open across polls, closed and opened again: one ack.
  await g.poll(); await g.click('×'); await g.click('Wharf progress'); await g.poll(); expect(acks()).toHaveLength(1);
  await g.click('×'); await g.tab('deck'); await g.click('Choose the next catch'); await g.click('×'); await g.tab('jobs'); await g.click('Build the hosted spyglass');
  expect(acks()).toHaveLength(1);
});
it('shows what the wharf records as seen and answered: acked reports, decisions and jobs, by whom', async () => {
  const ack = { at: '2026-10-10T17:05:00Z', by: 'boat:chris-macbook' };
  const seen = { ...snapshot, documents: [{ ...snapshot.documents[0]!, ack, answer: { option: 'Keep it small', at: '2026-10-10T17:06:00Z', by: 'person' } }, { ...snapshot.documents[1]!, ack: { at: '2026-10-10T17:07:00Z', by: 'person' } }] };
  const g = await page('/', false, { snapshot: seen, jobs: [{ ...jobs[0]!, ack: { ...ack, status: jobs[0]!.status!.at } }] });
  const card = (text: string) => Array.from(g.doc.querySelectorAll('button.card')).find((b) => b.textContent?.includes(text))!;
  expect(card('Choose the next catch').className).toContain('acked'); expect(card('Choose the next catch').textContent).toContain('answered'); expect(card('Choose the next catch').textContent).toContain('acked by boat:chris-macbook');
  await g.click('Choose the next catch'); expect(g.doc.querySelector('[role=dialog]')!.textContent).toContain('acked by boat:chris-macbook'); expect(g.doc.querySelector('[role=dialog]')!.textContent).toContain('answered: Keep it small'); await g.click('×');
  await g.tab('jobs'); expect(card('Build the hosted spyglass').className).toContain('acked'); expect(card('Build the hosted spyglass').textContent).toContain('acked by boat:chris-macbook');
  await g.click('Build the hosted spyglass'); expect(g.doc.querySelector('[role=dialog] .sub')!.textContent).toContain('acked by boat:chris-macbook'); await g.click('×');
  // A report already read is shown read, and opening it again tells the wharf nothing.
  await g.tab('reports'); expect(card('Wharf progress').textContent).toContain('report · read'); expect(card('Wharf progress').textContent).toContain('acked by person');
  await g.click('Wharf progress'); expect(g.writes.filter((w) => w.path.endsWith('/ack'))).toEqual([]);
  // Unseen items carry no such mark.
  const fresh = await page(); expect(fresh.doc.querySelector('.cards')!.textContent).not.toContain('acked by'); expect(fresh.doc.querySelector('button.card.acked')).toBeNull();
});
it('lists reviews in their own tab, waiting ones first; a card opens the review tool, and the page only dismisses', async () => {
  const s = structuredClone(snapshot), card = s.documents[0]!;
  const review = (id: string, state: string, stands: boolean, at: string) =>
    ({ ...card, id, kind: 'review' as const, title: `acme/web#${id} Add the thing`, options: [], at, author: 'boat:boat-1', ack: undefined, answer: undefined,
      review: { pr: `https://github.com/acme/web/pull/${id}`, round: 'RRE', state, stands, requestedBy: 'dana', open: `https://app.graphite.com/github/pr/acme/web/${id}` } });
  s.documents.push(review('8', 'posted', false, '2026-10-15T12:00:00.000Z'), review('7', 'drafted', true, '2026-10-15T10:00:00.000Z'));
  const g = await page('/#reviews', false, { snapshot: s });
  const cards = Array.from(g.doc.querySelectorAll('.cards a.card'));
  expect(cards.map((c) => c.querySelector('b')?.textContent)).toEqual(['acme/web#7 Add the thing', 'acme/web#8 Add the thing']);
  expect(cards.map((c) => c.getAttribute('href'))).toEqual(['https://app.graphite.com/github/pr/acme/web/7', 'https://app.graphite.com/github/pr/acme/web/8']);
  const h = await page('/#review/7', false, { snapshot: s });
  const dialog = h.doc.querySelector('[role=dialog]')!;
  expect(dialog.textContent).toContain('asked by dana · drafted');
  expect(dialog.querySelector('a.btn')?.getAttribute('href')).toBe('https://app.graphite.com/github/pr/acme/web/7');
  expect(Array.from(dialog.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual(['×', 'dismiss']);
  (Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'dismiss') as unknown as HTMLElement).click();
  await h.settle();
  expect(h.writes.at(-1)).toMatchObject({ path: '/api/glass/requests', body: { kind: 'review-dismiss', document: '7' } });
  expect(h.doc.body.textContent).toContain('sent to the boat that drafted it');
  expect(parseRoute('#review/7')).toEqual({ tab: 'reviews', item: { kind: 'review', id: '7' } });
});
