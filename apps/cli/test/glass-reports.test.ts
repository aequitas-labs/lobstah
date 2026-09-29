import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';
import { dispatchReportKey, ensureLayout, fileReport } from '@lobstah/core';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { serveReport } from '../src/glass.js';
import { parseMarkdown, parseInline } from '../src/glass-markdown.js';
import { lobItems } from '../src/glass-lobs.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, emptyFleet, everyAttentionFleet } from './fixtures/glass-snapshots.js';

/**
 * Reports in the spyglass: the deck's reports block, the report page in the
 * dispatch modal and in a helm report's own modal, the sanitized markdown,
 * and the read-only endpoint that serves a report's markdown and images.
 */

const TRAP_KEY = 'report:work:cccccccc-0000-4000-8000-000000000003';
const HELM_KEY = 'report:helm:fleet:0a1b2c3d';
const md = (key: string) => `/report/${encodeURIComponent(key)}/md`;
const TRAP_MD = [
  '# Tray findings',
  '',
  'The tray **fits** the *base* plate.',
  '',
  '![the tray](tray.png)',
  '',
  '| part | mm |',
  '| ---- | -: |',
  '| tray | 42 |',
  '',
  '```',
  'measure --all',
  '```',
  '',
  '- one',
  '- two',
  '',
  '[docs](https://example.com/docs) and [bad](javascript:alert(1))',
].join('\n');
const HELM_MD = '# Fleet notes\n\n<script>alert(1)</script><b>bold?</b>\n\n![remote](https://evil.example/x.png) ![up](../secrets.png)\n';

let open: GlassDom[] = [];
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-glass-reports-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});
async function page(d: GlassSnapshot, opts: Partial<GlassDomOptions> = {}): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, files: { [md(TRAP_KEY)]: TRAP_MD, [md(HELM_KEY)]: HELM_MD }, ...opts });
  open.push(g);
  return g;
}
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const click = async (g: GlassDom, el: Element | null) => {
  expect(el).toBeTruthy();
  (el as HTMLElement).click();
  await g.settle();
};
const escape = async (g: GlassDom) => {
  g.document.dispatchEvent(new (g.window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', { key: 'Escape' }));
  await g.settle();
};
const reportsSection = (g: GlassDom) => g.$$('#deck .deckgrid > section').find((s) => text(s.querySelector('h2')) === 'reports →')!;

describe('glass: the deck reports block', () => {
  it('lists reports after Landed, unacked first then newest: title, then who filed it, the age, and acked; no badge', async () => {
    for (const view of ['table', 'cards'] as const) {
      const g = await page(everyAttentionFleet(), { prefs: { view } });
      const headings = g.$$('#deck .deckgrid > section').map((s) => text(s.querySelector('h2')));
      expect(headings.indexOf('reports →')).toBe(headings.indexOf('Landed · 24h →') + 1);
      const rows = [...reportsSection(g).querySelectorAll(view === 'cards' ? '.card' : '.deckline')];
      expect(rows.map((r) => text(r.querySelector('b')))).toEqual(['Fleet notes', 'Tray findings', 'Build timings', 'Old fleet notes']);
      expect(reportsSection(g).querySelectorAll('.badge')).toHaveLength(0);
      const metas = rows.map((r) => text(view === 'cards' ? r.querySelector('.meta') : r.querySelector('.dim')));
      expect(metas).toEqual([
        view === 'cards' ? '5m ago' : '· 5m ago',
        (view === 'cards' ? '' : '· ') + 'kind-crab · 20m ago',
        (view === 'cards' ? '' : '· ') + 'aaaaaaaa · 40m ago',
        (view === 'cards' ? '' : '· ') + '60s ago · acked',
      ]);
      expect(rows[3]!.className).toContain('acked');
    }
  });

  it('shows eight at most, then "+N more" opens the Reports tab', async () => {
    const d = everyAttentionFleet();
    const base = d.reports[1]!;
    d.reports = Array.from({ length: 10 }, (_, i) => ({ ...base, key: `report:helm:fleet:0000000${i}`, title: `notes ${i}` }));
    const g = await page(d);
    expect(reportsSection(g).querySelectorAll('.deckline')).toHaveLength(8);
    const more = reportsSection(g).querySelector('.deckmore')!;
    expect(text(more)).toBe('+2 more →');
    expect(more.getAttribute('href')).toBe('#reports');
  });

  it('an empty fleet says none', async () => {
    const g = await page(emptyFleet());
    expect(text(reportsSection(g).querySelector('.empty'))).toBe('none');
  });
});

describe('glass: report modals', () => {
  it("a trap's report renders at the top of its dispatch modal: headings, image, table, code, links", async () => {
    const g = await page(everyAttentionFleet());
    await click(g, [...reportsSection(g).querySelectorAll('.deckline')].find((l) => text(l).includes('Tray findings')) ?? null);
    expect(text(g.$('#modalbox h3'))).toContain('cccccccc');
    const page_ = g.$('#modalbox .mdpage')!;
    expect(g.reportFetches()).toEqual([md(TRAP_KEY)]);
    expect(text(page_.querySelector('h1'))).toBe('Tray findings');
    expect(text(page_.querySelector('strong'))).toBe('fits');
    expect(text(page_.querySelector('em'))).toBe('base');
    expect(page_.querySelector('img')!.getAttribute('src')).toBe(`/report/${encodeURIComponent(TRAP_KEY)}/files/tray.png`);
    expect(page_.querySelector('img')!.getAttribute('alt')).toBe('the tray');
    expect([...page_.querySelectorAll('td')].map(text)).toEqual(['tray', '42']);
    expect(text(page_.querySelector('pre.mdcode'))).toBe('measure --all');
    expect(page_.querySelectorAll('li')).toHaveLength(2);
    const links = [...page_.querySelectorAll('a')];
    expect(links.map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
      ['https://example.com/docs', '_blank', 'noopener noreferrer'],
    ]);
    expect(text(page_)).toContain('bad');
    // The report sits above the brief and the attachments.
    const secs = g.$$('#modalbox .sec').map(text);
    expect(secs.indexOf('report · Tray findings')).toBeLessThan(secs.indexOf('brief'));
    expect(text(g.$('#modalbox'))).toContain('lobstah attention ack ' + TRAP_KEY);
  });

  it('a helm report opens in its own modal, and raw HTML shows as text', async () => {
    const g = await page(everyAttentionFleet());
    await click(g, [...reportsSection(g).querySelectorAll('.deckline')].find((l) => text(l).includes('Fleet notes')) ?? null);
    expect(text(g.$('#modalbox h3'))).toBe('📄 Fleet notes');
    const page_ = g.$('#modalbox .mdpage')!;
    expect(page_.querySelector('script')).toBeNull();
    expect(page_.querySelector('b')).toBeNull();
    expect(text(page_)).toContain('<script>alert(1)</script><b>bold?</b>');
    // A remote image and a path are not loaded.
    expect(page_.querySelectorAll('img')).toHaveLength(0);
    expect(text(page_)).toContain('[image not shown: remote]');
    expect(text(page_)).toContain('[image not shown: up]');
  });

  it('#report/<key> opens the report on load; opening it does not ack it', async () => {
    const g = await page(everyAttentionFleet(), { hash: '#report/' + encodeURIComponent(HELM_KEY) });
    expect(g.$('#overlay')!.className).toBe('open');
    expect(text(g.$('#modalbox h3'))).toBe('📄 Fleet notes');
    // The helm's own report: no "from", the age, and no "acked".
    expect(text(g.$('#modalbox .sub'))).toBe('5m ago');
    expect(text(g.$('#modalbox'))).toContain('lobstah attention ack ' + HELM_KEY);
    await g.poll();
    expect(g.reportFetches()).toEqual([md(HELM_KEY)]);
  });

  it('a dispatch key in #report/<key> opens that dispatch', async () => {
    const g = await page(everyAttentionFleet(), { hash: '#report/' + encodeURIComponent(TRAP_KEY) });
    expect(text(g.$('#modalbox h3'))).toContain('cccccccc');
    expect(text(g.$('#modalbox .mdpage h1'))).toBe('Tray findings');
  });
});

describe('glass: the Reports tab', () => {
  it('lists every report, unacked first then newest, in the table and cards; no author badge', async () => {
    const g = await page(everyAttentionFleet(), { hash: '#reports' });
    const rows = g.$$('#reports tr.rowhead');
    expect(g.$$('#reports th').map(text)).toEqual(['title', 'from', 'filed', 'acked']);
    expect(rows.map((r) => [...r.querySelectorAll('td')].map(text))).toEqual([
      ['Fleet notes', '', '5m', ''],
      ['Tray findings', 'kind-crab', '20m', ''],
      ['Build timings', 'aaaaaaaa', '40m', ''],
      ['Old fleet notes', '', '60s', 'acked'],
    ]);
    const cards = await page(everyAttentionFleet(), { hash: '#reports', prefs: { view: 'cards' } });
    expect(cards.$$('#reports .card b').map(text)).toEqual(['Fleet notes', 'Tray findings', 'Build timings', 'Old fleet notes']);
    expect(cards.$$('#reports .card .meta').map(text)).toEqual(['5m ago', 'kind-crab · 20m ago', 'aaaaaaaa · 40m ago', '60s ago · acked']);
    expect(cards.$$('#reports .badge')).toHaveLength(0);
  });

  it('search matches the title, author, dispatch id, and repo; the repo filter applies', async () => {
    const byQuery = await page(everyAttentionFleet(), { hash: '#reports', prefs: { q: 'aaaaaaaa' } });
    expect(byQuery.$$('#reports tr.rowhead').map((r) => text(r.querySelector('td')))).toEqual(['Build timings']);
    const byAuthor = await page(everyAttentionFleet(), { hash: '#reports', prefs: { q: 'kind-crab' } });
    expect(byAuthor.$$('#reports tr.rowhead').map((r) => text(r.querySelector('td')))).toEqual(['Tray findings']);
    const byRepo = await page(everyAttentionFleet(), { hash: '#reports', prefs: { repo: 'web' } });
    expect(byRepo.$$('#reports tr.rowhead').map((r) => text(r.querySelector('td')))).toEqual(['Tray findings', 'Build timings']);
  });

  it('a row opens its report: a dispatch report its dispatch, a helm report its own modal', async () => {
    const g = await page(everyAttentionFleet(), { hash: '#reports' });
    await click(g, g.$$('#reports tr.rowhead').find((r) => text(r).includes('Build timings')) ?? null);
    expect(text(g.$('#modalbox h3'))).toContain('aaaaaaaa');
    expect(g.$$('#modalbox .sub').map(text)).toContain('aaaaaaaa · 40m ago');
    await escape(g);
    await click(g, g.$$('#reports tr.rowhead').find((r) => text(r).includes('Fleet notes')) ?? null);
    expect(text(g.$('#modalbox h3'))).toBe('📄 Fleet notes');
  });
});

describe('glass: cards keep their text inside', () => {
  const longBadge = 'repairing: conflict (attempt 1 of 2) now'; // 40 characters
  const longMeta = 'implemented: migration_0136_form_outreach_reply_identity,submit/attribution/approval/outbound '.repeat(4).slice(0, 300);

  it('a 40-character badge truncates with its text in the title; a 300-character meta clamps to two lines with its text in the title', async () => {
    expect(longBadge).toHaveLength(40);
    const d = everyAttentionFleet();
    const x = d.dispatches.find((v) => v.bucket !== 'done')!;
    x.verb = longBadge as never;
    x.note = longMeta;
    const g = await page(d, { prefs: { view: 'cards' } });
    const card = g.$$('#deck .card').find((c) => text(c).includes(x.id.slice(0, 8)))!;
    const badge = card.querySelector('.top .badge')!;
    const meta = card.querySelector('.meta')!;
    expect(badge.getAttribute('title')).toBe(longBadge);
    expect(meta.getAttribute('title')).toContain(longMeta);
    const style = (el: Element) => g.window.getComputedStyle(el as never);
    expect(style(card)).toMatchObject({ overflow: 'hidden' });
    expect(style(card).getPropertyValue('overflow-wrap')).toBe('anywhere');
    expect(style(badge)).toMatchObject({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    expect(style(badge).getPropertyValue('max-width').replace(/\s/g, '')).toBe('min(26ch,100%)');
    expect(style(badge).getPropertyValue('flex')).toMatch(/^0 0 auto$/);
    expect(style(meta)).toMatchObject({ overflow: 'hidden' });
    // happy-dom does not compute line clamping: read the rule itself.
    const css = fs.readFileSync(new URL('../glass/glass.css', import.meta.url), 'utf8');
    for (const sel of ['.card .meta', '.card .note']) {
      const rule = css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
      expect(rule, sel).toMatch(/-webkit-line-clamp: 2;/);
      expect(rule, sel).toMatch(/overflow: hidden;/);
    }
    expect(style(card.querySelector('.top > b')!)).toMatchObject({ textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    // A short badge carries no title.
    const short = g.$$('#deck .card .top .badge').find((b) => text(b) === 'working');
    expect(short?.getAttribute('title') ?? null).toBeNull();
  });
});

describe('glass: the open-window button', () => {
  it('is a themed ↗ open button at the end of the foot line, and its click does not open the trap modal', async () => {
    const d = everyAttentionFleet();
    d.focusSupported = true;
    d.focusToken = 'fixture-token';
    for (const view of ['cards', 'table'] as const) {
      const g = await page(d, { hash: '#traps', prefs: { view } });
      const button = g.$(view === 'cards' ? '#traps .card .foot .footact button' : '#traps tr.rowhead td:last-child button')!;
      expect(text(button)).toBe('↗ open');
      expect(button.className).toBe('btn open');
      await click(g, button);
      expect(g.$('#overlay')!.className).toBe('');
    }
    const deck = await page(d, { prefs: { view: 'cards' } });
    const button = deck.$('#deck .card .foot .footact button')!;
    expect(text(button)).toBe('↗ open');
    await click(deck, button);
    expect(deck.$('#overlay')!.className).toBe('');
  });
});

describe('glass: a report lob', () => {
  it('walks with the report label and opens its report', () => {
    const items = lobItems(
      [
        { id: '0a1b2c3d', lane: 'work', verb: 'report', kind: 'report', key: HELM_KEY, stateHash: 'r2', note: 'Fleet notes' },
        { id: 'cccccccc-0000-4000-8000-000000000003', lane: 'work', verb: 'report', kind: 'report', key: TRAP_KEY, stateHash: 'r1', note: 'Tray findings' },
      ],
      { lobs: true, preview: false },
    );
    expect(items.map((i) => [i.label, i.text, i.open])).toEqual([
      ['report', 'Fleet notes', { type: 'report', key: HELM_KEY }],
      ['report', 'Tray findings', { type: 'dispatch', key: 'work:cccccccc-0000-4000-8000-000000000003' }],
    ]);
  });
});

describe('glass: the report markdown', () => {
  it('parses headings, lists, tables, code, and inline marks', () => {
    const blocks = parseMarkdown(TRAP_MD);
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'p', 'table', 'code', 'list', 'p']);
    expect(parseInline('a **b** *c* `d` \\*e')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'b', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'i', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'd' },
      { t: 'text', v: ' *e' },
    ]);
  });
});

describe('glass: the report endpoint', () => {
  interface Reply {
    status: number;
    headers: Record<string, string>;
    body: Buffer | string;
  }
  const get = (url: string): Reply | undefined => {
    const reply: Reply = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead: (status: number, headers: Record<string, string>) => {
        reply.status = status;
        reply.headers = headers;
      },
      end: (body: Buffer | string) => {
        reply.body = body;
      },
    } as unknown as http.ServerResponse;
    return serveReport(url, res) ? reply : undefined;
  };

  it('serves the markdown as text and an image from the report attachments only', () => {
    ensureLayout();
    const src = path.join(home, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'r.md'), '# R\n\n![p](p.png)\n');
    fs.writeFileSync(path.join(src, 'p.png'), 'PNG');
    fs.writeFileSync(path.join(src, 'x.svg'), '<svg/>');
    fs.writeFileSync(path.join(home, 'secret.png'), 'SECRET');
    const key = dispatchReportKey('eeeeeeee-0000-4000-8000-000000000005', 'work');
    fileReport({ key, file: path.join(src, 'r.md'), attach: [path.join(src, 'p.png'), path.join(src, 'x.svg')], fallbackTitle: 'r', author: 'headless', maxBytes: 1_000_000 });
    const k = encodeURIComponent(key);

    const text_ = get(`/report/${k}/md`)!;
    expect(text_.status).toBe(200);
    expect(text_.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(text_.headers['x-content-type-options']).toBe('nosniff');
    expect(String(text_.body)).toContain('# R');

    const img = get(`/report/${k}/files/p.png`)!;
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(String(img.body)).toBe('PNG');

    // Paths, traversal, unknown names, other types, and unknown keys are refused.
    for (const url of [
      `/report/${k}/files/..%2F..%2Fsecret.png`,
      `/report/${k}/files/..%2Fattachments%2Fp.png`,
      `/report/${k}/files/${encodeURIComponent(path.join(home, 'secret.png'))}`,
      `/report/${k}/files/secret.png`,
      `/report/${k}/files/x.svg`,
      `/report/${encodeURIComponent('report:work:../../secret')}/md`,
      `/report/${encodeURIComponent('report:helm:..:00000000')}/md`,
      `/report/%E0%A4%A/md`,
    ]) {
      expect(get(url)?.status, url).toBe(404);
    }
    expect(get(`/report/${k}/files/../../secret.png`)).toBeUndefined();
  });
});
