import { readFileSync } from 'node:fs';
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

it('uses the exact sign-in copy and original transparent mark and marketing art', async () => {
  const g = await page();
  expect(g.doc.querySelectorAll('button')).toHaveLength(1);
  expect(g.doc.querySelector('button')?.textContent).toContain('Continue with GitHub');
  expect(g.doc.querySelector('.github-mark path')?.getAttribute('d')).toContain('M6.766 11.328');
  const originalImage = (selector: string, file: string) => {
    const src = g.doc.querySelector(selector)?.getAttribute('src') ?? '';
    expect(src).toMatch(/^data:image\/(png|webp);base64,/);
    expect(Buffer.from(src.split(',')[1]!, 'base64')).toEqual(readFileSync(new URL(file, import.meta.url)));
  };
  originalImage('.auth-brand img', '../../../docs/assets/favicon.png');
  originalImage('.auth-features li:nth-child(1) img', '../../../apps/site/assets/buoy-flag-160.webp');
  originalImage('.auth-buoy img:last-child', '../../../apps/site/assets/buoy-body-160.webp');
  originalImage('.auth-features li:nth-child(2) img', '../../../apps/site/assets/trap-180.webp');
  expect(g.doc.querySelector('.auth-crawl svg image')?.getAttribute('href')).toContain('data:image/png;base64,');
  expect(g.doc.querySelector('.auth-brand')?.textContent).toBe('lobstah spyglass');
  expect(g.doc.querySelector('h1')?.firstChild?.textContent).toBe('Your fleet');
  expect(g.doc.querySelector('h1 br')).not.toBeNull();
  expect(g.doc.querySelector('h1 span')?.textContent).toBe('in sight');
  expect([...g.doc.querySelectorAll('.auth-features li > span:last-child')].map(el => el.textContent)).toEqual([
    'Answer when a buoy flags you', "Know what's working and what's stuck", 'Haul up the catch: PRs, evidence and reports',
  ]);
  expect(g.doc.querySelector('#auth-title')?.textContent).toBe('Welcome aboard');
  expect(g.doc.querySelector('#auth-detail')).toBeNull();
  expect(g.doc.querySelector('.auth-access')?.textContent).toBe('GitHub only confirms who you are. It grants no repository access');
  expect(g.doc.querySelector('.auth-footer')?.textContent).toBe('Nobody stares at the water');
  expect(g.doc.querySelector('.auth-eyebrow, .auth-card-top, .auth-lede')).toBeNull();
  expect(g.doc.title).toBe('Welcome aboard · lobstah spyglass');
  expect(g.doc.querySelector('nav')).toBeNull();
  expect(g.doc.querySelector('.chips')).toBeNull();
});

it.each([
  ['invite_required', 'Not on the crew list', "This GitHub account isn't invited to this wharf. Ask its owner to add you"],
  ['access_denied', 'Sign-in cancelled', "Continue with GitHub when you're ready"],
  ['state_not_found', 'Your session timed out', 'Sign in again to pick up where you left off'],
  ['unknown', "Sign-in didn't finish", 'Something went wrong on the way back from GitHub. Try again in a moment'],
])('gives a friendly %s callback state without trusting provider descriptions or reading account data', async (code, title, detail) => {
  const g = await page('/api/auth/error?error=' + code + '&error_description=%3Cimg%20src=x%3E');
  expect(g.doc.querySelector('#auth-title')?.textContent).toBe(title);
  expect(g.doc.querySelector('#auth-detail')?.textContent).toBe(detail);
  expect(g.doc.title).toBe(title + ' · lobstah spyglass');
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
    expect(g.doc.querySelector('[role=status]')?.textContent).toBe('Opening GitHub…');
    expect(g.doc.querySelector('#auth-detail')).toBeNull();
    expect(g.doc.querySelector('button')?.textContent).toBe('Continue with GitHub');
    expect(g.doc.title).toBe('Opening GitHub… · lobstah spyglass');
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
    expect(g.doc.querySelector('#auth-title')?.textContent).toBe(status === 401 ? 'Your session timed out' : 'Not on the crew list');
    expect(g.doc.body.textContent).not.toContain('Choose the next catch');
    const count = g.reads.length; await g.poll(); expect(g.reads).toHaveLength(count);
  }
  const g = await page('/', 200); await g.click('sign out');
  expect(g.doc.querySelector('#auth-title')?.textContent).toBe('Ashore for now');
  expect(g.doc.querySelector('#auth-detail')?.textContent).toBe("Sign in again whenever you're ready");
});
