import { Window } from 'happy-dom';
import { afterEach, expect, it } from 'vitest';
import { GLASS_SCRIPT, GLASS_CSS } from '../../../services/wharf/src/glass-page.generated.js';
import { authDestination } from '../../../services/wharf/glass/src/auth-screen.js';
import { snapshot } from './fixtures/wharf-glass.js';

const windows: Window[] = [];
afterEach(async () => { await Promise.all(windows.map((w) => w.happyDOM.close())); windows.length = 0; });
async function page(path = '/', initialStatus = 401, startStatus = 200) {
  const window = new Window({ url: 'https://glass.test' + path, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  windows.push(window);
  const writes: { path: string; body: Record<string, unknown> }[] = [], reads: string[] = [], assigned: string[] = [], intervals: (() => void)[] = [];
  let status = initialStatus;
  const w = window as unknown as Record<string, unknown>;
  w.setInterval = (fn: () => void) => { intervals.push(fn); return intervals.length; };
  w.clearInterval = () => {};
  w.WebSocket = class { close() {} };
  Object.defineProperty(window.location, 'assign', { value: (url: string) => assigned.push(url) });
  w.fetch = async (path: string, init: RequestInit = {}) => {
    if (init.method === 'POST') {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      if (path === '/api/auth/sign-in/social') return Response.json(startStatus === 200 ? { url: 'https://github.com/login/oauth/authorize?state=fixture' } : { error: '<unsafe provider text>' }, { status: startStatus });
      return Response.json({ success: true });
    }
    reads.push(path);
    return status === 200 ? Response.json(path === '/api/glass' ? snapshot : []) : Response.json({ error: '<unsafe provider text>' }, { status });
  };
  const settle = async () => { for (let i = 0; i < 4; i++) { await window.happyDOM.waitUntilComplete(); await new Promise((r) => setTimeout(r, 0)); } };
  window.document.write(`<!doctype html><html><head><style>${GLASS_CSS}</style></head><body><script>${GLASS_SCRIPT}</script></body></html>`);
  await settle();
  const click = async (text: string) => {
    const button = [...window.document.querySelectorAll('button')].find((el) => el.textContent?.includes(text));
    expect(button, text).toBeTruthy(); button!.click(); await settle();
  };
  return { window, doc: window.document, writes, reads, assigned, settle, click, setStatus: (next: number) => { status = next; }, poll: async () => { intervals.forEach((fn) => fn()); await settle(); } };
}

it('shows one GitHub action, the lobster with its star, and truthful account access on initial sign-in', async () => {
  const g = await page();
  expect(g.doc.querySelectorAll('button')).toHaveLength(1);
  expect(g.doc.querySelector('button')?.textContent).toContain('Continue with GitHub');
  expect(g.doc.querySelector('.github-mark path')?.getAttribute('d')).toContain('M6.766 11.328');
  expect(g.doc.querySelector('.auth-brand img')?.getAttribute('src')).toBe('/icons/icon-192.png');
  expect(g.doc.body.textContent).toContain('repositories connected by their boats');
  expect(g.doc.querySelector('nav')).toBeNull();
  expect(g.doc.querySelector('.chips')).toBeNull();
});

it.each([
  ['invite_required', 'Let’s get you on the list.'],
  ['access_denied', 'No rush. We’re here.'],
  ['state_not_found', 'Let’s reconnect.'],
  ['unknown', 'We couldn’t sign you in.'],
])('gives a friendly %s callback state without trusting provider descriptions or reading account data', async (code, title) => {
  const g = await page('/api/auth/error?error=' + code + '&error_description=%3Cimg%20src=x%3E');
  expect(g.doc.querySelector('#auth-title')?.textContent).toBe(title);
  expect(g.doc.body.textContent).not.toContain('<img src=x>');
  expect(g.reads).toEqual([]);
  expect(g.doc.querySelector('button')?.textContent).toContain('Continue with GitHub');
});

it('preserves the item or boat approval target and shows the GitHub handoff while preventing duplicate submissions', async () => {
  for (const target of ['/#decision/card', '/device?user_code=ABC']) {
    const g = await page(target);
    await g.click('Continue with GitHub');
    const body = g.writes[0]!.body;
    expect(body.callbackURL).toBe('https://glass.test' + target);
    expect(new URL(String(body.errorCallbackURL)).pathname).toBe('/api/auth/error');
    expect(new URL(String(body.errorCallbackURL)).searchParams.get('returnTo')).toBe(target);
    expect(g.assigned).toEqual(['https://github.com/login/oauth/authorize?state=fixture']);
    expect(g.doc.querySelector('button')?.disabled).toBe(true);
    expect(g.doc.querySelector('[role=status]')?.textContent).toContain('Opening GitHub');
    g.doc.querySelector('button')!.click(); await g.settle(); expect(g.writes).toHaveLength(1);
  }
});

it('retries a callback at its original glass destination, rejecting foreign and malformed retry targets', async () => {
  const g = await page('/api/auth/error?error=state_mismatch&returnTo=' + encodeURIComponent('/device?user_code=ABC'));
  await g.click('Continue with GitHub');
  expect(g.writes[0]!.body.callbackURL).toBe('https://glass.test/device?user_code=ABC');
  for (const target of ['https://evil.test/', '//evil.test/device', '/api/auth/callback/github', 'http://[']) {
    const location = new URL('https://glass.test/api/auth/error?returnTo=' + encodeURIComponent(target));
    expect(authDestination(location).href).toBe('https://glass.test/');
  }
});

it.each([403, 503])('makes a failed OAuth start (%i) retryable and focuses its friendly error', async (status) => {
  const g = await page('/', 401, status);
  await g.click('Continue with GitHub');
  expect(g.assigned).toEqual([]);
  expect(g.doc.querySelector('button')?.disabled).toBe(false);
  expect(g.doc.activeElement?.id).toBe('auth-title');
  expect(g.doc.body.textContent).not.toContain('<unsafe provider text>');
  await g.click('Continue with GitHub'); expect(g.writes).toHaveLength(2);
});

it('clears expired or denied account details and gives a separate signed-out state', async () => {
  for (const status of [401, 403]) {
    const g = await page('/', 200);
    g.setStatus(status); await g.poll();
    expect(g.doc.querySelector('#auth-title')?.textContent).toBe(status === 401 ? 'Let’s reconnect.' : 'Let’s get you on the list.');
    expect(g.doc.body.textContent).not.toContain('Choose the next catch');
    const count = g.reads.length; await g.poll(); expect(g.reads).toHaveLength(count);
  }
  const g = await page('/', 200); await g.click('sign out');
  expect(g.doc.querySelector('#auth-title')?.textContent).toBe('See you soon.');
});
