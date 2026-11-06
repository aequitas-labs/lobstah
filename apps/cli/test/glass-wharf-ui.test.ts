import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { jobs, markdown, snapshot } from './fixtures/wharf-glass.js';

/**
 * The shared glass UI, started on the wharf backend, against the wharf's
 * browser API (the hosted glass's own fixture). It renders the account with
 * the local glass's components, lists only the wharf's tabs, and writes
 * through the wharf's cookie-only routes.
 */

let page = '';
beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/glass-wharf-entry.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    loader: { '.png': 'dataurl' },
    logLevel: 'silent',
  });
  const script = result.outputFiles[0]!.text.replace(/<\/(script)/gi, '<\\/$1');
  const at = GLASS_PAGE.indexOf('<script>');
  page = GLASS_PAGE.slice(0, at) + '<script>' + script + GLASS_PAGE.slice(GLASS_PAGE.indexOf('</script>', at));
});

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.map((w) => w.happyDOM.close()));
  windows.length = 0;
});

/** The page on the glass host, its fetches answered from the fixture, every request recorded. */
async function open(hash = '#deck') {
  const window = new Window({
    url: 'https://glass.test/' + hash,
    width: 1280,
    height: 800,
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  } as ConstructorParameters<typeof Window>[0]);
  windows.push(window);
  const calls: Array<{ path: string; method: string; body?: string; credentials?: string }> = [];
  const w = window as unknown as Record<string, unknown>;
  w.fetch = async (path: string, init: RequestInit = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body as string | undefined, credentials: init.credentials });
    const answer = (status: number, body: unknown) => new window.Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    if (path === '/api/glass') return answer(200, snapshot);
    if (path === '/api/glass/dispatches') return answer(200, jobs);
    if (path.includes('/files/')) return answer(200, markdown);
    if (init.method === 'POST') return answer(200, { ok: true });
    return answer(404, { error: 'route not found' });
  };
  // The poll and presence intervals never run on their own here; the first poll is enough.
  w.setInterval = () => 0;
  w.clearInterval = () => {};
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await window.happyDOM.waitUntilComplete();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  window.document.write(page);
  await settle();
  const $ = (s: string) => window.document.querySelector(s);
  const text = (s: string) => ($(s)?.textContent ?? '').replace(/\s+/g, ' ');
  const go = async (h: string) => {
    window.location.hash = h;
    await settle();
  };
  return { window, calls, $, text, go, settle };
}

describe('the shared glass on the wharf backend', () => {
  it("shows the wharf's decision and job with the local glass's components", async () => {
    const g = await open('#deck');
    expect(g.text('#deck')).toContain('Choose the next catch');
    await g.go('#dispatches');
    expect(g.text('#dispatches')).toContain('working');
    expect(g.text('#dispatches')).toContain('Browser controls and cookie boundary tests in progress.');
  });

  it("lists only the wharf's tabs", async () => {
    const g = await open('#deck');
    const tabs = [...g.window.document.querySelectorAll('#tabs a')].map((a) => a.getAttribute('data-tab'));
    expect(tabs).toEqual(['deck', 'dispatches', 'traps', 'reviews', 'reports']);
  });

  it('reads only same-origin wharf routes, with the cookie', async () => {
    const g = await open('#deck');
    expect(g.calls.length).toBeGreaterThan(0);
    expect(g.calls.every((c) => c.path.startsWith('/api/glass') && c.credentials === 'same-origin')).toBe(true);
    expect(g.calls.some((c) => c.path === '/data')).toBe(false);
  });
});
