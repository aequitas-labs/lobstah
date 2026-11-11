import { Window } from 'happy-dom';
import * as fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { GLASS_SCRIPT, GLASS_CSS } from '../../../services/wharf/src/glass-page.generated.js';
import { snapshot, jobs, detail, markdown } from './fixtures/wharf-glass.js';
import { attachCommand, resume } from '../../../services/wharf/glass/src/model.js';

/**
 * The hosted glass: GitHub sign-in around the shared glass on the wharf
 * backend. Its views are the local glass's own components; these tests pin
 * what is the host's (sign-in, sign-out, the wake hint, boats, boat approval,
 * the links boats hand out) and the browser boundary: cookie-only,
 * same-origin, an idempotency key on every write, no bearer and no helm seat.
 */

let windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.map((w) => w.happyDOM.close()));
  windows = [];
});

type Data = { snapshot?: typeof snapshot; jobs?: typeof jobs; detail?: typeof detail; badge?: (count: number) => Promise<void>; userAgent?: string; card?: unknown };

async function page(path = '/', signedOut = false, data: Data = {}) {
  const window = new Window({
    url: 'https://glass.test' + path,
    width: 1280,
    height: 800,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      ...(data.userAgent ? { navigator: { userAgent: data.userAgent } } : {}),
    },
  } as ConstructorParameters<typeof Window>[0]);
  windows.push(window);
  const w = window as unknown as Record<string, unknown>;
  const writes: { path: string; method: string; body: Record<string, unknown>; headers: Record<string, string>; credentials?: string }[] = [];
  const reads: string[] = [];
  const copied: string[] = [];
  const intervals: (() => void)[] = [];
  const opened: string[] = [];
  let unauthenticated = signedOut;
  const sockets: { url: string; onopen?: (() => void) | null; onmessage?: ((e: { data: string }) => void) | null; onclose?: (() => void) | null; closed: boolean; close(): void }[] = [];
  w.WebSocket = class {
    onopen?: (() => void) | null;
    onmessage?: ((e: { data: string }) => void) | null;
    onclose?: (() => void) | null;
    closed = false;
    constructor(public url: string) {
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  };
  w.setInterval = (fn: () => void) => {
    intervals.push(fn);
    return intervals.length;
  };
  w.clearInterval = (id: number) => {
    intervals[id - 1] = () => {};
  };
  w.open = (url: string) => {
    opened.push(url);
    return null;
  };
  w.fetch = async (path: string, init: RequestInit = {}) => {
    reads.push(path);
    const method = init.method ?? 'GET';
    const record = () =>
      writes.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : {}, headers: (init.headers ?? {}) as Record<string, string>, credentials: init.credentials });
    // Sign-in answers a signed-out page; the fixture sends it back to the same document.
    if (path === '/api/auth/sign-in/social') {
      record();
      return Response.json({ url: window.location.href });
    }
    if (unauthenticated) return Response.json({ error: 'sign in' }, { status: 401 });
    if (method !== 'GET') {
      record();
      return Response.json({ success: true });
    }
    if (path === '/api/glass') return Response.json(data.snapshot ?? snapshot);
    if (path === '/api/glass/dispatches') return Response.json(data.jobs ?? jobs);
    if (path === '/api/glass/dispatches/job/detail') return Response.json(data.detail ?? detail);
    if (path === '/api/glass/cards/c42') return Response.json(data.card);
    if (path.endsWith('/image') || path.endsWith('/worker-image')) return new Response(new Uint8Array([137, 80, 78, 71]));
    if (path.includes('/files/')) return new Response(markdown);
    if (path.startsWith('/api/auth/device?'))
      return Response.json({ boatName: 'chris-macbook-2', requestedPermissions: ['work', 'helm'], description: 'Work and steer the helm.', status: 'pending' });
    throw new Error('unexpected path ' + path);
  };
  w.TextDecoder = TextDecoder;
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (s: string) => copied.push(s) } });
  if (data.badge) Object.defineProperty(window.navigator, 'setAppBadge', { value: data.badge });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await window.happyDOM.waitUntilComplete();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  window.document.write(`<!doctype html><html><head><style>${GLASS_CSS}</style></head><body><script>${GLASS_SCRIPT}</script></body></html>`);
  await settle();
  const doc = window.document;
  const find = (selector: string, text?: string) =>
    Array.from(doc.querySelectorAll(selector)).find((e) => text === undefined || (e.textContent ?? '').includes(text)) as unknown as HTMLElement | undefined;
  const click = async (selector: string, text?: string) => {
    const el = find(selector, text);
    expect(el, `${selector} ${text ?? ''}`).toBeTruthy();
    el!.click();
    await settle();
  };
  const go = async (hash: string) => {
    window.location.hash = hash;
    await settle();
  };
  const input = (label: string, text: string) => {
    const node = doc.querySelector(`[aria-label='${label}']`)! as unknown as HTMLInputElement;
    node.value = text;
    node.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
  };
  const text = (selector = 'body') => (doc.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ');
  return {
    window,
    doc,
    writes,
    reads,
    copied,
    sockets,
    opened,
    settle,
    click,
    find,
    go,
    input,
    text,
    activeTab: () => doc.querySelector('#tabs a.on')?.getAttribute('data-tab'),
    poll: async () => {
      intervals.forEach((f) => f());
      await settle();
    },
    unauthenticated: () => {
      unauthenticated = true;
    },
  };
}

it('badges only open account decisions, updates on existing polls, and clears on sign-out', async () => {
  const badges: number[] = [];
  const s = structuredClone(snapshot),
    card = s.documents[0]!;
  s.documents.push(
    { ...card, id: 'second' },
    { ...card, id: 'answered', answer: { at: card.at, by: 'person', text: 'Yes' } },
    { ...card, id: 'withdrawn', withdrawn: true },
  );
  const g = await page('/', false, { snapshot: s, badge: async (n: number) => void badges.push(n) });
  expect(badges.at(-1)).toBe(2);
  const reads = g.reads.length;
  s.documents = s.documents.filter((d) => d.id !== 'second');
  await g.poll();
  expect(badges.at(-1)).toBe(1);
  expect(g.reads.slice(reads)).toEqual(['/api/glass', '/api/glass/dispatches']);
  s.documents = [];
  await g.poll();
  expect(badges.at(-1)).toBe(0);
  s.documents = [card];
  await g.poll();
  expect(badges.at(-1)).toBe(1);
  await g.click('button', 'Sign out');
  expect(badges.at(-1)).toBe(0);
});

it("the phone menu lists the boats' fleet chips and signs out", async () => {
  const g = await page('/');
  await g.click('.bottombar button', 'Menu');
  expect(g.text('#phone-menu')).toContain('Boats');
  expect(g.text('#phone-menu')).toContain('helm');
  await g.click('#phone-menu button', 'Sign out');
  expect(g.text()).toContain('Continue with GitHub');
});

it('keeps the hosted glass usable when the OS denies app badges', async () => {
  const g = await page('/', false, {
    badge: async () => {
      throw new Error('not allowed');
    },
  });
  await g.poll();
  expect(g.text('#deck')).toContain('Choose the next catch');
});

it('uses a cookie-only wake hint, retains polling on a drop and closes hints on sign-out', async () => {
  const g = await page();
  expect(g.sockets).toHaveLength(1);
  expect(String(g.sockets[0]!.url)).toBe('wss://glass.test/api/glass/wake');
  const reads = g.reads.length;
  g.sockets[0]!.onmessage?.({ data: '{"type":"wake"}' });
  await g.settle();
  expect(g.reads.length).toBeGreaterThan(reads);
  g.sockets[0]!.onclose?.();
  await g.poll();
  expect(g.sockets).toHaveLength(2);
  await g.click('button', 'Sign out');
  expect(g.sockets[1]!.closed).toBe(true);
  await g.poll();
  expect(g.sockets).toHaveLength(2);
});

it("renders the wharf in the local glass's own views and tabs", async () => {
  const g = await page();
  expect(Array.from(g.doc.querySelectorAll('#tabs a')).map((a) => a.getAttribute('data-tab'))).toEqual([
    'deck',
    'dispatches',
    'traps',
    'boats',
    'reviews',
    'reports',
  ]);
  // The local glass's header, deck sections and footer; no daemon, PRs or local-only commands on a wharf.
  expect(g.doc.querySelector('.headerline h1')?.textContent).toContain('spyglass');
  expect(g.text('.chips')).toContain('helm live');
  expect(g.text('.chips')).not.toContain('daemon');
  expect(g.text('#deck')).toContain('in flight');
  expect(g.text('#deck')).not.toContain('PRs');
  expect(g.text('#foot')).toContain('lobstah · wharf · PR watches and repair run on your boats');
});

it('shows jobs, notes, reports, PR links and messages in the dispatch modal, without claiming window focus', async () => {
  const g = await page();
  expect(g.text('#deck')).toContain('waiting for helm');
  await g.go('#dispatches');
  await g.click('#dispatches tr', 'job');
  const modal = g.text('#modalbox');
  expect(modal).toContain('Build the hosted spyglass');
  expect(modal).toContain('Browser controls');
  expect(modal).toContain('Waiting for review');
  expect(modal).toContain('Please preserve local behavior.');
  expect(g.doc.querySelector("#modalbox a[href='https://github.com/aequitas-labs/lobstah/pull/205']")).toBeTruthy();
  expect(g.doc.querySelector('#modalbox button.btn.open')).toBeNull();
  expect(g.reads).toContain('/api/glass/dispatches/job/detail');
  await g.click('#modalbox .x');
  await g.go('#traps');
  expect(g.doc.querySelector('#traps .harness-icon')?.getAttribute('aria-label')).toBe('Codex');
  expect(g.text('#traps')).toContain('kind-crab');
  expect(g.doc.querySelector('#traps button.btn.open')).toBeNull();
});

it('offers a live worker its attach command or where it runs, and never resume', () => {
  const worker = { ...snapshot.workers[0]!, live: true };
  expect(resume(worker)).toBe('codex resume test-session');
  expect(attachCommand(worker)).toBeUndefined();
  const inPane = { ...worker, tmuxPane: '%12' };
  expect(attachCommand(inPane)).toBe('ssh chris-macbook -t tmux -L lobstah attach -r -t %12');
  expect(attachCommand({ ...inPane, tmuxPane: '%1;id' })).toBeUndefined();
  expect(attachCommand({ ...inPane, boatName: '-oProxyCommand=id' })).toBeUndefined();
});

it('says where a live worker runs, on its boat, and offers no window it cannot open', async () => {
  const live = { ...snapshot, workers: [{ ...snapshot.workers[0]!, live: true, lastCheckIn: new Date().toISOString() }] };
  const g = await page('/#traps', false, { snapshot: live, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1' });
  expect(g.text('#traps')).toContain('Running on chris-macbook, only reachable from there');
  expect(g.doc.querySelector('#traps button.btn.open')).toBeNull();
});

it('renders decisions as safe elements, requests only their own attachment images, and answers through the wharf', async () => {
  const g = await page();
  await g.click('button.dopen', 'Choose the next catch');
  const modal = g.doc.querySelector('.dmodal')!;
  expect(modal.textContent).toContain('<script>alert(1)</script>');
  expect(modal.querySelector('script')).toBeNull();
  expect(modal.querySelector("a[href^='javascript:']")).toBeNull();
  expect(g.reads.some((s) => s.includes('evil') || s.includes('other.png'))).toBe(false);
  await g.click('.dmodal .dopt', 'Keep it small');
  g.input('Your answer, in your own words', 'Go ahead');
  await g.settle();
  await g.click('.dmodal button[aria-label="Send"]');
  expect(g.writes).toContainEqual(expect.objectContaining({ path: '/api/glass/documents/card/answer', body: { option: 'Keep it small', text: 'Go ahead' } }));
  // The wharf takes no files: the answer offers none.
  expect(g.doc.querySelector('.dmodal .dattach')).toBeNull();
});

it('queues messages, confirms direct cancellation, and sends no bearer or helm takeover', async () => {
  const g = await page('/#dispatches');
  await g.click('#dispatches tr', 'job');
  g.input('message to helm', 'Please retry');
  await g.settle();
  await g.click('#modalbox button', 'Queue message for helm');
  expect(g.writes[0]).toMatchObject({ path: '/api/glass/requests', body: { kind: 'message', dispatch: 'job', text: 'Please retry' }, credentials: 'same-origin' });
  await g.click('#modalbox button', 'Cancel dispatch…');
  expect(g.writes).toHaveLength(1);
  expect(g.text('#modalbox')).toContain('Cancel this dispatch? Its agent stops.');
  await g.click('#modalbox button', 'Cancel dispatch');
  expect(g.writes[1]).toMatchObject({ path: '/api/glass/dispatches/job/cancel', body: {} });
  for (const write of g.writes) {
    expect(write.headers['Idempotency-Key']).toBeTruthy();
    expect(write.headers.Authorization).toBeUndefined();
    expect(write.headers['X-Lobstah-Helm']).toBeUndefined();
    expect(write.credentials).toBe('same-origin');
  }
  expect(g.writes.some((w) => w.path.includes('helm/'))).toBe(false);
});

it('boats show repos and check-in, no edit/grant controls; revoke and delete each require confirmation', async () => {
  const g = await page('/#boats');
  // The card shows the boat's access and age; a tap shows its repos, last check-in and trap request.
  expect(g.text('#boats')).not.toContain('github.com/aequitas-labs/lobstah');
  (g.doc.querySelector('#boats .card') as unknown as HTMLElement).click();
  await g.settle();
  expect(g.text('#boats')).toContain('last check-in');
  expect(g.text('#boats')).toContain('github.com/aequitas-labs/lobstah');
  expect(Array.from(g.doc.querySelectorAll('#boats button')).some((b) => /edit|grant|rename/i.test(b.textContent ?? ''))).toBe(false);
  // Access in the approval page's words.
  expect(g.text('#boats')).toContain('Work, see and steer');
  expect(g.text('#boats')).not.toContain('work + helm');
  await g.click('#boats button', 'revoke…');
  expect(g.writes).toHaveLength(0);
  expect(g.text('#boats')).toContain('keep chris-macbook');
  await g.click('#boats button', 'revoke chris-macbook');
  expect(g.writes[0]!.path).toBe('/api/glass/boats/boat/revoke');
  expect(g.text()).toContain('Boat revoked.');
  await g.click('#boats button', 'request trap…');
  await g.click('#boats button', 'queue trap request');
  expect(g.writes[1]).toMatchObject({ body: { kind: 'trap-request', boat: 'boat', repo: 'github.com/aequitas-labs/lobstah' } });
  await g.click('#boats button', 'delete account…');
  expect(g.writes).toHaveLength(2);
  await g.click('#boats button', 'confirm delete account');
  expect(g.writes[2]).toMatchObject({ path: '/api/glass/account', method: 'DELETE', body: { confirm: true } });
  expect(g.text()).toContain('Continue with GitHub');
});

it('a boat card shows its name and state chip, then its access and age; a revoked one is greyed with no revoke', async () => {
  const fresh = { ...snapshot.boats[0]!, id: 'fresh', name: 'studio', lastCheckIn: new Date().toISOString() };
  const gone = { ...snapshot.boats[0]!, id: 'gone', name: 'old-mini', revoked: 1 };
  const g = await page('/#boats', false, { snapshot: { ...snapshot, boats: [snapshot.boats[0]!, fresh, gone] } });
  const cards = Array.from(g.doc.querySelectorAll('#boats .card'));
  const line = (c: Element, sel: string) => (c.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  expect(cards.map((c) => [line(c, '.gtitle'), line(c, '.gchip')])).toEqual([
    ['chris-macbook', 'asleep'],
    ['studio', 'online'],
    ['old-mini', 'revoked'],
  ]);
  expect(line(cards[0]!, '.gcontext .gtext')).toMatch(/^Work, see and steer · checked in \d+\w ago$/);
  // Asleep is a grey chip, with no status edge.
  expect(cards[0]!.querySelector('.gchip')!.className).toBe('gchip dim');
  expect(cards[0]!.className).not.toContain('gcard-edge');
  expect(line(cards[0]!, '.gaction')).toBe('revoke…');
  expect(cards[2]!.className).toContain('quiet');
  expect(cards[2]!.querySelector('.gaction')).toBeNull();
  // revoke… never expands the card; a tap or Enter does.
  await g.click('#boats .card button', 'revoke…');
  expect(cards[0]!.getAttribute('aria-expanded')).toBe('false');
  cards[1]!.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event);
  await g.settle();
  expect(g.doc.querySelectorAll('#boats .card')[1]!.getAttribute('aria-expanded')).toBe('true');
});

it('boat approval shows the resolved name and allows only requested or lower access, never admin', async () => {
  const g = await page('/device?user_code=test-code');
  expect(g.text()).toContain('Approve chris-macbook-2?');
  const select = g.doc.querySelector('[aria-label="Access"]')! as unknown as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.value)).toEqual(['helm', 'read', 'none']);
  select.value = 'read';
  select.dispatchEvent(new g.window.Event('change', { bubbles: true }) as unknown as Event);
  await g.settle();
  await g.click('button', 'Approve');
  expect(g.writes[0]).toMatchObject({
    path: '/api/auth/wharf/approve',
    body: { userCode: 'test-code', name: 'chris-macbook-2', requestedPermissions: ['work', 'helm'], permissions: ['work', 'read'] },
  });
});

it('an expired cookie clears stale account details and asks for GitHub sign-in', async () => {
  const g = await page();
  g.unauthenticated();
  await g.poll();
  expect(g.text()).toContain('Continue with GitHub');
  expect(g.doc.querySelector('#tabs')).toBeNull();
  expect(g.text()).not.toContain('Choose the next catch');
});

it('sign-out stops polling instead of restoring account details on the next interval', async () => {
  const g = await page();
  await g.click('button', 'Sign out');
  const reads = g.reads.length;
  await g.poll();
  expect(g.reads).toHaveLength(reads);
  expect(g.doc.querySelector('#tabs')).toBeNull();
  expect(g.text()).not.toContain('Choose the next catch');
});

it('opens on the decision, job or trap its link names, in that item’s view', async () => {
  const decision = await page('/#decision/card');
  expect(decision.text('.dmodal')).toContain('Choose the next catch');
  expect(decision.reads).toContain('/api/glass/documents/card/files/md');
  expect(decision.activeTab()).toBe('deck');
  const job = await page('/#job/job');
  expect(job.text('#modalbox')).toContain('Browser controls');
  expect(job.reads).toContain('/api/glass/dispatches/job/detail');
  expect(job.activeTab()).toBe('dispatches');
  const trap = await page('/#trap/kind-crab');
  expect(trap.text('#modalbox')).toContain('kind-crab');
  expect(trap.activeTab()).toBe('traps');
  expect((await page('/#jobs')).activeTab()).toBe('dispatches');
  expect((await page('/#reports')).activeTab()).toBe('reports');
});

it("opens a report's own page from its link, reads its Markdown, and acks it once", async () => {
  const link = await page('/#report/report');
  expect(link.window.location.pathname).toBe('/report/report');
  const g = await page('/report/report');
  expect(g.text('.reportview')).toContain('Wharf progress');
  expect(g.text('.reportview')).toContain('Small, safe changes');
  expect(g.reads).toContain('/api/glass/documents/report/files/report-md');
  const acks = g.writes.filter((w) => w.path.endsWith('/ack'));
  expect(acks).toEqual([expect.objectContaining({ path: '/api/glass/documents/report/ack', body: {}, credentials: 'same-origin' })]);
  expect(acks[0]!.headers['Idempotency-Key']).toBeTruthy();
  expect(acks[0]!.headers.Authorization).toBeUndefined();
  // The local glass's ack command runs on a daemon; the wharf page acks by opening.
  expect(g.text('.reportview')).not.toContain('lobstah attention ack');
});

it('says so when a link names nothing on this wharf, and reads no file for it', async () => {
  const g = await page('/report/card');
  expect(g.text('.reportview')).toContain('report not found');
  expect(g.reads.some((r) => r.includes('/files/report'))).toBe(false);
  const job = await page('/#job/another');
  expect(job.doc.querySelector('#overlay.open')).toBeNull();
  expect(job.reads.some((r) => r.endsWith('/detail'))).toBe(false);
  // Anything that is not a view or an item is the deck, with nothing open.
  const other = await page('/#decision/../boats');
  expect(other.doc.querySelector('#overlay.open')).toBeNull();
  expect(other.activeTab()).toBe('deck');
});

it('carries a link through sign-in: the item waits behind the sign-in button and returns as the callback', async () => {
  const g = await page('/#decision/card', true);
  expect(g.text()).toContain('Continue with GitHub');
  expect(g.doc.querySelector('.dmodal')).toBeNull();
  expect(g.window.location.hash).toBe('#decision/card');
  await g.click('button', 'Continue with GitHub');
  expect(g.writes[0]).toMatchObject({ path: '/api/auth/sign-in/social', body: { provider: 'github', callbackURL: 'https://glass.test/#decision/card' } });
});

it('opening a decision acks it once with the page’s cookie, and opening a job acks nothing', async () => {
  const g = await page();
  await g.click('button.dopen', 'Choose the next catch');
  const acks = () => g.writes.filter((w) => w.path.endsWith('/ack'));
  expect(acks()).toEqual([expect.objectContaining({ path: '/api/glass/documents/card/ack', body: {}, credentials: 'same-origin' })]);
  await g.poll();
  await g.click('.dmodal button.x');
  await g.go('#dispatches');
  await g.click('#dispatches tr', 'job');
  expect(acks()).toHaveLength(1);
});

it('shows what the wharf records as seen: a read report stays read, and opening it again tells the wharf nothing', async () => {
  const seen = { ...snapshot, documents: [snapshot.documents[0]!, { ...snapshot.documents[1]!, ack: { at: '2026-10-10T17:07:00Z', by: 'person' } }] };
  const g = await page('/report/report', false, { snapshot: seen });
  expect(g.text('.reportview')).toContain('Wharf progress');
  expect(g.writes.filter((w) => w.path.endsWith('/ack'))).toEqual([]);
});

it('lists reviews in their own tab, waiting ones first; a card opens the review tool, and the page only dismisses', async () => {
  const s = structuredClone(snapshot),
    card = s.documents[0]!;
  const review = (id: string, state: string, stands: boolean, at: string) => ({
    ...card,
    id,
    kind: 'review' as const,
    title: `acme/web#${id} Add the thing`,
    options: [],
    at,
    author: 'boat:boat-1',
    ack: undefined,
    answer: undefined,
    review: { pr: `https://github.com/acme/web/pull/${id}`, round: 'RRE', state, stands, requestedBy: 'dana', open: `https://app.graphite.com/github/pr/acme/web/${id}` },
  });
  s.documents.push(review('8', 'posted', false, '2026-10-15T12:00:00.000Z'), review('7', 'drafted', true, '2026-10-15T10:00:00.000Z'));
  const g = await page('/#reviews', false, { snapshot: s, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15' });
  expect(g.text('#reviews')).toContain('acme/web#7 Add the thing');
  expect(g.text('#reviews')).toContain('acme/web#8 Add the thing');
  expect(g.text('#reviews').indexOf('#7 Add')).toBeLessThan(g.text('#reviews').indexOf('#8 Add'));
  // Only the still-open round can be dismissed, and there is nothing else to press.
  const buttons = Array.from(g.doc.querySelectorAll('#reviews button')).map((b) => b.textContent?.trim());
  expect(buttons).toEqual(['Dismiss']);
  await g.click('#reviews button', 'Dismiss');
  expect(g.writes.at(-1)).toMatchObject({ path: '/api/glass/requests', body: { kind: 'review-dismiss', document: '7' } });
  expect(g.text('#reviews')).toContain('Sent to the boat that drafted it');
  await g.go('#review/7');
  expect(g.activeTab()).toBe('reviews');
});

it('links bare http(s) URLs in decisions, notes, briefs and messages as text, never markup', async () => {
  const PR = 'https://github.com/aequitas-labs/lobstah/pull/205',
    LOCAL = 'http://127.0.0.1:5173/review/abc';
  const s = structuredClone(snapshot),
    j = structuredClone(jobs),
    d = structuredClone(detail);
  s.documents[0]!.options = [`Ship it (${PR})`, 'Wait'];
  j[0]!.brief = `Build the hosted spyglass\nSee ${LOCAL}, and <b>keep</b> \`https://code.example\` as code.`;
  j[0]!.status!.note = `<script>alert(1)</script> review ${PR}. javascript:alert(2)`;
  d.brief = j[0]!.brief;
  d.messages[0]!.text = `see ${PR}`;
  const links = (el: Element | null | undefined) => Array.from(el?.querySelectorAll('a.autolink') ?? []).map((a) => a.getAttribute('href'));
  const g = await page('/', false, { snapshot: s, jobs: j, detail: d });
  await g.click('button.dopen', 'Choose the next catch');
  expect(links(g.doc.querySelector('.dmodal .dopt'))).toEqual([PR]);
  await g.click('.dmodal button.x');
  await g.go('#dispatches');
  const row = g.find('#dispatches tr', 'job')!;
  expect(row.querySelector('script')).toBeNull();
  expect(row.textContent).toContain('<script>alert(1)</script> review ');
  await g.click('#dispatches tr', 'job');
  const modal = g.doc.querySelector('#modalbox')!;
  expect(links(modal)).toEqual(expect.arrayContaining([LOCAL, PR]));
  expect(modal.textContent).toContain('<b>keep</b>');
  expect(modal.querySelector("a[href^='javascript:']")).toBeNull();
});

it('uses the transparent lobster-and-star mark for main glass branding', async () => {
  const g = await page();
  const canonical = 'data:image/png;base64,' + fs.readFileSync(new URL('../../../docs/assets/favicon.png', import.meta.url)).toString('base64');
  const logos = g.doc.querySelectorAll('h1 .glass-brand, #foot .glass-brand');
  expect(logos).toHaveLength(2);
  for (const logo of logos) expect(logo.getAttribute('src')).toBe(canonical);
});

it('opens a canonical boat card link in the signed-in shared glass', async () => {
  const g = await page('/#card/c42', false, { card: {
    id: 'c42', family: 'permission', source: 'boat:boat', key: 'permission', revision: 1,
    sourceAt: new Date().toISOString(), title: 'Allow the deployment', grounds: 'home', links: [], actions: [],
  } });
  expect(g.reads).toContain('/api/glass/cards/c42');
  expect(g.doc.body.textContent).toContain('Allow the deployment');
  expect(g.doc.body.textContent).toContain('permission · boat');
});
