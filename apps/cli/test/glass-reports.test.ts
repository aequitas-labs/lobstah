import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dispatchReportKey, ensureLayout, fileReport, listReports } from '@lobstah/core';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { serveGlass, serveReport } from '../src/glass.js';
import { parseMarkdown, parseInline } from '../src/glass-markdown.js';
import { lobItems } from '../src/glass-lobs.js';
import { NOTE_MAX } from '../src/glass-poll.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, ago, emptyFleet, everyAttentionFleet } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Reports in the spyglass: the deck's reports block, the report's own page
 * (rendered once, never polled), the link to it from a dispatch's modal, the
 * sanitized markdown, and the read-only endpoints that serve a report's page,
 * row, markdown, and images.
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
  removeTempDir(home);
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

describe('glass: a report page', () => {
  const pagePath = (key: string) => `/report/${encodeURIComponent(key)}`;
  const meta = (key: string) => `/report/${encodeURIComponent(key)}/meta`;
  const reportPage = async (key: string) => {
    const fleet = everyAttentionFleet();
    const row = (fleet.reports ?? []).find((r) => r.key === key)!;
    return page(fleet, { path: pagePath(key), files: { [md(TRAP_KEY)]: TRAP_MD, [md(HELM_KEY)]: HELM_MD, [meta(key)]: JSON.stringify(row) } });
  };

  it("renders a trap's report once: headings, image, table, code, links, byline, and the ack command", async () => {
    const g = await reportPage(TRAP_KEY);
    expect(g.reportFetches()).toEqual([meta(TRAP_KEY), md(TRAP_KEY)]);
    expect(text(g.$('.reportview h1'))).toBe('Tray findings');
    expect(text(g.$('.reportview .sub'))).toBe('kind-crab · 20m ago');
    const page_ = g.$('.reportview .mdpage')!;
    expect(text(page_.querySelector('h1'))).toBe('Tray findings');
    expect(text(page_.querySelector('strong'))).toBe('fits');
    expect(page_.querySelector('img')!.getAttribute('src')).toBe(`/report/${encodeURIComponent(TRAP_KEY)}/files/tray.png`);
    expect([...page_.querySelectorAll('td')].map(text)).toEqual(['tray', '42']);
    expect(text(page_.querySelector('pre.mdcode'))).toBe('measure --all');
    expect([...page_.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
      ['https://example.com/docs', '_blank', 'noopener noreferrer'],
    ]);
    expect(text(g.$('.reportview'))).toContain('lobstah attention ack ' + TRAP_KEY);
    expect(g.document.title).toBe('Tray findings · lobstah glass');
    // It never polls: no /data fetch, so nothing re-renders while someone reads.
    // Its one interval reports its presence, so the pet can show an item here.
    expect(g.fetches()).toBe(0);
    expect(g.intervals()).toEqual([2000]);
    expect(g.presence()[0]).toMatch(/^\/api\/presence\?page=[A-Za-z0-9_-]{8,64}&vis=visible$/);
    expect(g.$('#deck')).toBeNull();
  });

  it('shows raw HTML in a helm report as text and loads no remote or path image', async () => {
    const g = await reportPage(HELM_KEY);
    const page_ = g.$('.reportview .mdpage')!;
    expect(page_.querySelector('script')).toBeNull();
    expect(page_.querySelector('b')).toBeNull();
    expect(text(page_)).toContain('<script>alert(1)</script><b>bold?</b>');
    expect(page_.querySelectorAll('img')).toHaveLength(0);
    expect(text(page_)).toContain('[image not shown: remote]');
  });

  it('says so when the report is gone', async () => {
    const g = await page(everyAttentionFleet(), { path: pagePath('report:helm:fleet:ffffffff') });
    expect(text(g.$('.reportview .bad'))).toBe('report not found (404)');
  });

  it('an old #report/<key> link goes to the report page and starts nothing else', async () => {
    for (const key of [HELM_KEY, TRAP_KEY]) {
      const g = await page(everyAttentionFleet(), { hash: '#report/' + encodeURIComponent(key) });
      expect(g.replaced()).toEqual([pagePath(key)]);
      expect(g.fetches()).toBe(0);
    }
  });

  it("a dispatch's modal names its report and links to the page; it renders no markdown", async () => {
    const g = await page(everyAttentionFleet(), { hash: '#dispatches' });
    await click(g, g.$$('#dispatches tr.rowhead').find((r) => text(r).includes('cccccccc')) ?? null);
    expect(g.$$('#modalbox .sec').map(text)).toContain('report · Tray findings');
    const link = [...g.$$('#modalbox a')].find((a) => text(a) === 'open the report ↗')!;
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual([pagePath(TRAP_KEY), '_blank', 'noopener']);
    expect(g.$('#modalbox .mdpage')).toBeNull();
    expect(g.reportFetches()).toEqual([]);
  });

  it("the deck's reports block links each report to its page in a new tab", async () => {
    const g = await page(everyAttentionFleet());
    const lines = [...reportsSection(g).querySelectorAll('a.deckline')];
    const tray = lines.find((l) => text(l).includes('Tray findings'))!;
    expect([tray.getAttribute('href'), tray.getAttribute('target'), tray.getAttribute('rel')]).toEqual([pagePath(TRAP_KEY), '_blank', 'noopener']);
    const cards = await page(everyAttentionFleet(), { prefs: { view: 'cards' } });
    const card = [...reportsSection(cards).querySelectorAll('a.card')].find((c) => text(c).includes('Fleet notes'))!;
    expect(card.getAttribute('href')).toBe(pagePath(HELM_KEY));
    expect(card.getAttribute('target')).toBe('_blank');
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

  it("a row, a card, or the title opens the report's own page in a new tab", async () => {
    const g = await page(everyAttentionFleet(), { hash: '#reports' });
    await click(g, g.$$('#reports tr.rowhead').find((r) => text(r).includes('Build timings')) ?? null);
    const buildKey = (everyAttentionFleet().reports ?? []).find((r) => r.title === 'Build timings')!.key;
    expect(g.opened()).toEqual([[`/report/${encodeURIComponent(buildKey)}`, '_blank', 'noopener']]);
    expect(g.$('#overlay')!.className).toBe('');
    const title = g.$$('#reports tr.rowhead td a').find((a) => text(a) === 'Fleet notes')!;
    expect([title.getAttribute('href'), title.getAttribute('target'), title.getAttribute('rel')]).toEqual([`/report/${encodeURIComponent(HELM_KEY)}`, '_blank', 'noopener']);
    const cards = await page(everyAttentionFleet(), { hash: '#reports', prefs: { view: 'cards' } });
    const card = cards.$$('#reports a.card').find((c) => text(c).includes('Tray findings'))!;
    expect([card.getAttribute('href'), card.getAttribute('target'), card.getAttribute('rel')]).toEqual([`/report/${encodeURIComponent(TRAP_KEY)}`, '_blank', 'noopener']);
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
    // /data cuts a note to NOTE_MAX characters; the modal's detail has all of it.
    expect(meta.getAttribute('title')).toContain(`${longMeta.slice(0, NOTE_MAX)}…`);
    const style = (el: Element) => g.window.getComputedStyle(el as never);
    expect(style(card)).toMatchObject({ overflow: 'hidden' });
    expect(style(card).getPropertyValue('overflow-wrap')).toBe('anywhere');
    expect(style(badge)).toMatchObject({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    expect(badge.className).toContain('long');
    expect(style(badge).getPropertyValue('max-width').replace(/\s/g, '')).toBe('min(26ch,100%)');
    expect(style(badge).getPropertyValue('min-width').replace(/\s/g, '')).toBe('min(12ch,100%)');
    expect(style(badge).getPropertyValue('flex')).toMatch(/^0 1 auto$/);
    expect(style(meta)).toMatchObject({ overflow: 'hidden' });
    // happy-dom does not compute line clamping: read the rule itself.
    const css = fs.readFileSync(new URL('../glass/glass.css', import.meta.url), 'utf8');
    for (const sel of ['.card .meta', '.card .note']) {
      const rule = css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
      expect(rule, sel).toMatch(/-webkit-line-clamp: 2;/);
      expect(rule, sel).toMatch(/overflow: hidden;/);
    }
    expect(style(card.querySelector('.top > b')!)).toMatchObject({ textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    // The title keeps room for its identity (#99999, an 8-character id); the badge gives way first.
    expect(style(card.querySelector('.top > b')!).getPropertyValue('min-width').replace(/\s/g, '')).toBe('min(10ch,100%)');
    // A short badge carries no title.
    const short = g.$$('#deck .card .top .badge').find((b) => text(b) === 'working');
    expect(short?.getAttribute('title') ?? null).toBeNull();
  });
});

describe('glass: a PR card with a long badge', () => {
  it('keeps the whole PR number: the title holds room for #99999, the badge truncates', async () => {
    const d = everyAttentionFleet();
    const p = d.prs.find((x) => x.state === 'OPEN')!;
    p.number = 1826;
    p.badge = { ...p.badge, text: 'repairing: checks (attempt 1 of 2)' };
    const g = await page(d, { hash: '#prs', prefs: { view: 'cards' } });
    const card = g.$$('#prs .card').find((c) => text(c.querySelector('.prname')).startsWith('#1826'))!;
    const title = card.querySelector('.top > .prname')!;
    expect(text(title.querySelector('b'))).toBe('#1826');
    const badge = card.querySelector('.top .badge')!;
    expect(badge.getAttribute('title')).toBe('repairing: checks (attempt 1 of 2)');
    const style = (el: Element) => g.window.getComputedStyle(el as never);
    expect(style(title).getPropertyValue('min-width').replace(/\s/g, '')).toBe('min(10ch,100%)');
    // '#99999' and an 8-character id are at most eight characters: 10ch holds either and the ellipsis after it.
    expect('dddddddd'.length + 1).toBeLessThanOrEqual(10 - 1);
    // The title shrinks first (1000000 to the badge's 1); the long badge then truncates, never below 12ch.
    expect(style(title).getPropertyValue('flex-shrink')).toBe('1000000');
    expect(badge.className).toContain('long');
    expect(style(badge).getPropertyValue('flex-shrink')).toBe('1');
    expect(style(badge).getPropertyValue('min-width').replace(/\s/g, '')).toBe('min(12ch,100%)');
  });
});

describe('glass: short card badges stay whole', () => {
  it('a done badge beside a long title and a trap harness badge never shrink; only a badge over 12 characters is long', async () => {
    const d = everyAttentionFleet();
    d.landed[0] = { ...d.landed[0]!, repo: 'a-repository-name-long-enough-to-crowd-the-badge', verb: 'done', at: ago(60_000) };
    const g = await page(d, { prefs: { view: 'cards' } });
    const style = (el: Element) => g.window.getComputedStyle(el as never);
    const landed = g.$$('#deck .card').find((c) => text(c.querySelector('b')).includes('a-repository-name-long'))!;
    const done = landed.querySelector('.top > .badge')!;
    expect(text(done)).toBe('done');
    expect(done.className).not.toContain('long');
    expect(done.getAttribute('title')).toBeNull();
    expect(style(done).getPropertyValue('flex')).toBe('0 0 auto');
    const title = landed.querySelector('.top > b')!;
    expect(style(title).getPropertyValue('flex-shrink')).toBe('1000000');
    const trap = g.$$('#deck .card').find((c) => text(c.querySelector('b')).includes('wt:t1'))!;
    const claude = trap.querySelector('.top > .badge')!;
    expect(text(claude)).toBe('claude');
    expect(claude.className).not.toContain('long');
    expect(style(claude).getPropertyValue('flex')).toBe('0 0 auto');
    // Twelve characters is still whole; thirteen is long.
    for (const [verb, long] of [['twelve-chars', false], ['thirteen-char', true]] as const) {
      const e = everyAttentionFleet();
      e.dispatches.find((v) => v.bucket !== 'done')!.verb = verb as never;
      const p = await page(e, { hash: '#dispatches', prefs: { view: 'cards' } });
      const badge = p.$$('#dispatches .card .top .badge').find((b) => text(b) === verb)!;
      expect(badge.className.includes('long'), verb).toBe(long);
    }
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
  it("walks with the report label and links to the report's page", () => {
    const items = lobItems(
      [
        { id: '0a1b2c3d', lane: 'work', verb: 'report', kind: 'report', key: HELM_KEY, stateHash: 'r2', note: 'Fleet notes' },
        { id: 'cccccccc-0000-4000-8000-000000000003', lane: 'work', verb: 'report', kind: 'report', key: TRAP_KEY, stateHash: 'r1', note: 'Tray findings' },
      ],
      { lobs: true, preview: false },
    );
    expect(items.map((i) => [i.label, i.text, i.href, i.open])).toEqual([
      ['report', 'Fleet notes', `/report/${encodeURIComponent(HELM_KEY)}`, undefined],
      ['report', 'Tray findings', `/report/${encodeURIComponent(TRAP_KEY)}`, undefined],
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

describe('glass: a block quote', () => {
  it('parses to the end: a quote, a nested quote, and the text after it', () => {
    const blocks = parseMarkdown('> one\n> two\n>\n> > inner\n\nafter\n\n> last');
    expect(blocks.map((b) => b.t)).toEqual(['quote', 'p', 'quote']);
    const quote = blocks[0] as { t: 'quote'; c: Array<{ t: string }> };
    expect(quote.c.map((b) => b.t)).toEqual(['p', 'quote']);
  });

  it('parses a long report with quotes in milliseconds', () => {
    const report = Array.from({ length: 200 }, (_, i) => `## Part ${i}\n\n> a quoted line ${i}\n> and more\n\n| a | b |\n| - | - |\n| ${i} | x |\n`).join('\n');
    const t = performance.now();
    expect(parseMarkdown(report).filter((b) => b.t === 'quote')).toHaveLength(200);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe('glass: the report page route', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });
  const get = (base: string, url: string, host?: string): Promise<{ status?: number; type?: string; body: string }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(`${base}${url}`, { headers: host ? { Host: host } : {} }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] ?? ''), body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('serves the page and the row to its own host only, refuses a rebound name, and never acks', async () => {
    ensureLayout();
    const src = path.join(home, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'r.md'), '# Findings\n\n> quoted\n');
    const key = dispatchReportKey('eeeeeeee-0000-4000-8000-000000000006', 'work');
    fileReport({ key, file: path.join(src, 'r.md'), attach: [], fallbackTitle: 'r', author: 'headless', maxBytes: 1_000_000 });
    server = serveGlass(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const k = encodeURIComponent(key);

    const pageRes = await get(base, `/report/${k}`);
    expect(pageRes.status).toBe(200);
    expect(pageRes.type).toBe('text/html; charset=utf-8');
    expect(pageRes.body).toBe(GLASS_PAGE);
    const metaRes = await get(base, `/report/${k}/meta`);
    expect(metaRes.status).toBe(200);
    expect(JSON.parse(metaRes.body)).toMatchObject({ key, title: 'Findings', author: 'headless' });
    expect((await get(base, `/report/${k}/md`)).body).toContain('> quoted');

    // A name rebound to this machine is refused.
    expect((await get(base, `/report/${k}`, 'evil.example')).status).toBe(403);
    expect((await get(base, `/report/${k}/meta`, 'evil.example')).status).toBe(403);
    // An unknown key is a 404.
    expect((await get(base, `/report/${encodeURIComponent('report:helm:fleet:ffffffff')}`)).status).toBe(404);
    expect((await get(base, `/report/${encodeURIComponent('report:helm:fleet:ffffffff')}/meta`)).status).toBe(404);

    // Opening the page, its row, and its markdown acks nothing.
    expect(listReports().find((r) => r.key === key)).toBeDefined();
    expect(JSON.parse((await get(base, `/report/${k}/meta`)).body).acked).toBeUndefined();
    expect(fs.existsSync(path.join(home, 'acks')) ? fs.readdirSync(path.join(home, 'acks')) : []).toEqual([]);
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
