import { afterEach, describe, expect, it } from 'vitest';
import type { GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { linkParts, safeUrl, urlAt } from '../src/glass-links.js';
import { parseInline, parseMarkdown } from '../src/glass-markdown.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, acceptanceFleet, ago, everyAttentionFleet } from './fixtures/glass-snapshots.js';

/**
 * Bare URLs in the glass's free text become links: one helper
 * (glass-links.ts) finds them for the markdown parser and for plain text in
 * both glasses, and the pages render them as `<a target="_blank"
 * rel="noopener noreferrer">` around text nodes, never as markup.
 */

const url = (u: string) => ({ url: u });

describe('glass links: what is a URL', () => {
  it('links http and https URLs with a host, and nothing else', () => {
    expect(linkParts('see https://example.com/a and http://example.org')).toEqual(['see ', url('https://example.com/a'), ' and ', url('http://example.org')]);
    expect(linkParts('HTTPS://EXAMPLE.COM/X')).toEqual([url('HTTPS://EXAMPLE.COM/X')]);
    for (const s of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.com/', 'mailto:a@b.c', 'file:///etc/passwd', 'http://', 'https:// spaced', 'www.example.com'])
      expect(linkParts(s), s).toEqual([s]);
    expect(safeUrl('javascript://example.com/%0aalert(1)')).toBeUndefined();
    expect(safeUrl('https://example.com')).toBe('https://example.com');
  });

  it('never links javascript: or data: hidden after a scheme-looking prefix or glued to a word', () => {
    expect(linkParts('xhttp://evil.example/')).toEqual(['xhttp://evil.example/']);
    expect(linkParts('javascript:http://evil.example/')).toEqual(['javascript:', url('http://evil.example/')]);
    expect(linkParts('data:http://evil.example')).toEqual(['data:', url('http://evil.example')]);
  });

  it('leaves trailing punctuation out of the link', () => {
    expect(linkParts('Merged: https://github.com/a/b/pull/1.')).toEqual(['Merged: ', url('https://github.com/a/b/pull/1'), '.']);
    expect(linkParts('https://a.example/x, https://b.example/y; done')).toEqual([url('https://a.example/x'), ', ', url('https://b.example/y'), '; done']);
    expect(linkParts('is it https://a.example/q?!')).toEqual(['is it ', url('https://a.example/q'), '?!']);
    expect(linkParts('https://a.example/x...')).toEqual([url('https://a.example/x'), '...']);
    expect(linkParts('https://a.example/?q=1&r=2#frag.')).toEqual([url('https://a.example/?q=1&r=2#frag'), '.']);
  });

  it('keeps balanced parentheses and drops an unbalanced closing one', () => {
    expect(linkParts('(see https://a.example/x)')).toEqual(['(see ', url('https://a.example/x'), ')']);
    expect(linkParts('(see https://a.example/x).')).toEqual(['(see ', url('https://a.example/x'), ').']);
    expect(linkParts('https://en.wikipedia.org/wiki/Lobster_(food)')).toEqual([url('https://en.wikipedia.org/wiki/Lobster_(food)')]);
    expect(linkParts('(https://en.wikipedia.org/wiki/Lobster_(food))')).toEqual(['(', url('https://en.wikipedia.org/wiki/Lobster_(food)'), ')']);
    expect(linkParts('[https://a.example/x]')).toEqual(['[', url('https://a.example/x'), ']']);
  });

  it('finds several URLs on one line and stops at quotes, brackets, and whitespace', () => {
    expect(linkParts('a https://a.example b https://b.example c https://c.example')).toEqual([
      'a ',
      url('https://a.example'),
      ' b ',
      url('https://b.example'),
      ' c ',
      url('https://c.example'),
    ]);
    expect(linkParts('{"prUrl":"https://github.com/a/b/pull/2","n":2}')).toEqual(['{"prUrl":"', url('https://github.com/a/b/pull/2'), '","n":2}']);
    expect(linkParts('<https://a.example/x>')).toEqual(['<', url('https://a.example/x'), '>']);
    expect(linkParts("'https://a.example/x'")).toEqual(["'", url('https://a.example/x'), "'"]);
    expect(linkParts('line one https://a.example\nhttps://b.example')).toEqual(['line one ', url('https://a.example'), '\n', url('https://b.example')]);
  });

  it('links localhost and IP URLs with ports and paths', () => {
    expect(linkParts('open http://127.0.0.1:5173/review/abc?x=1 now')).toEqual(['open ', url('http://127.0.0.1:5173/review/abc?x=1'), ' now']);
    expect(linkParts('glass at http://localhost:4949/#deck.')).toEqual(['glass at ', url('http://localhost:4949/#deck'), '.']);
    expect(linkParts('http://[::1]:8080/x')).toEqual([url('http://[::1]:8080/x')]);
  });

  it('leaves URLs inside code spans as they are', () => {
    expect(linkParts('run `curl https://a.example/x` then https://b.example')).toEqual(['run `curl https://a.example/x` then ', url('https://b.example')]);
    expect(linkParts('``a `https://a.example` b``')).toEqual(['``a `https://a.example` b``']);
    expect(linkParts('a lone ` then https://b.example')).toEqual(['a lone ` then ', url('https://b.example')]);
  });

  it('keeps the text exactly: the parts join back to the input', () => {
    const s = '<script>alert(1)</script> & https://a.example/?a=<b>&c=1 "q" (https://b.example/x_(y)).';
    expect(linkParts(s).map((p) => (typeof p === 'string' ? p : p.url)).join('')).toBe(s);
    expect(urlAt(s, s.indexOf('https://a'))).toBe('https://a.example/?a=');
  });
});

describe('glass links: the markdown', () => {
  it('links bare URLs in text, keeps code spans and fenced code as code, and never nests a link', () => {
    expect(parseInline('see https://a.example/x.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'a', href: 'https://a.example/x', c: [{ t: 'text', v: 'https://a.example/x' }] },
      { t: 'text', v: '.' },
    ]);
    expect(parseInline('`https://a.example/x`')).toEqual([{ t: 'code', v: 'https://a.example/x' }]);
    expect(parseInline('[docs https://a.example](https://b.example)')).toEqual([
      { t: 'a', href: 'https://b.example', c: [{ t: 'text', v: 'docs https://a.example' }] },
    ]);
    expect(parseInline('**https://a.example/_x_**')).toEqual([
      { t: 'b', c: [{ t: 'a', href: 'https://a.example/_x_', c: [{ t: 'text', v: 'https://a.example/_x_' }] }] },
    ]);
    expect(parseMarkdown('```\nhttps://a.example\n```')).toEqual([{ t: 'code', lang: '', v: 'https://a.example' }]);
    const table = parseMarkdown('| https://a.example | b |\n| - | - |\n| c | http://127.0.0.1:5173/x |')[0] as { head: unknown[][]; rows: unknown[][][] };
    expect(table.head[0]).toEqual([{ t: 'a', href: 'https://a.example', c: [{ t: 'text', v: 'https://a.example' }] }]);
    expect(table.rows[0]![1]).toEqual([{ t: 'a', href: 'http://127.0.0.1:5173/x', c: [{ t: 'text', v: 'http://127.0.0.1:5173/x' }] }]);
  });
});

let open: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(open.map((g) => g.close()));
  open = [];
});
async function page(d: GlassSnapshot, opts: Partial<GlassDomOptions> = {}): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, ...opts });
  open.push(g);
  return g;
}
const links = (el: Element | null | undefined) =>
  [...(el?.querySelectorAll('a.autolink, .mdpage a') ?? [])].map((a) => [a.getAttribute('href'), a.textContent, a.getAttribute('target'), a.getAttribute('rel')]);
const ext = (u: string, label = u) => [u, label, '_blank', 'noopener noreferrer'];

const PR = 'https://github.com/acme/web/pull/43';
const NOTE = `<script>alert(1)</script> review ${PR}. javascript:alert(2) \`http://127.0.0.1:5173/x\``;

function linkFleet(): GlassSnapshot {
  const d = acceptanceFleet();
  const c = d.dispatches.find((x) => x.id.startsWith('cccccccc'))!;
  c.note = NOTE;
  c.log = [{ at: ago(60_000), verb: 'needs-decision', note: `see http://127.0.0.1:5173/review/abc, then (${PR})` }];
  d.notices[2]!.text = `#40 merged: https://github.com/acme/web/pull/40.`;
  d.todos = [{ grounds: 'home', id: 1, text: 'read https://docs.example/a and https://docs.example/b', createdAt: ago(60_000), done: false, stale: false }];
  d.goals = [{ grounds: 'home', date: '2026-09-24', lines: ['ship https://github.com/acme/web/pull/41'] }];
  return d;
}

describe('glass links: the local glass', () => {
  it('a dispatch note links its URL as text, never markup, and the click stays off the card', async () => {
    for (const view of ['table', 'cards'] as const) {
      const g = await page(linkFleet(), { prefs: { view }, hash: '#dispatches' });
      const host = view === 'cards' ? g.$$('#dispatches .card').find((c) => c.textContent?.includes('cccccccc'))! : g.$$('#dispatches tr').find((r) => r.textContent?.includes('cccccccc'))!;
      expect(links(host)).toEqual([ext(PR)]);
      expect(host.querySelector('script')).toBeNull();
      expect(host.textContent).toContain('<script>alert(1)</script> review ');
      if (view === 'cards') expect(host.textContent).toContain('`http://127.0.0.1:5173/x`');
      (host.querySelector('a.autolink') as HTMLElement).click();
      await g.settle();
      expect(g.$('#overlay')!.className).not.toBe('open');
    }
  });

  it('the dispatch modal links its last note, log, and evidence', async () => {
    const g = await page(linkFleet(), { hash: '#dispatches' });
    (g.$$('#dispatches tr').find((r) => r.textContent?.includes('cccccccc')) as HTMLElement).click();
    await g.settle();
    const box = g.$('#modalbox')!;
    const hrefs = links(box).map((l) => l[0]);
    expect(hrefs).toContain('http://127.0.0.1:5173/review/abc');
    expect(hrefs).toContain(PR);
    expect(hrefs.every((h) => /^https?:\/\//.test(h!))).toBe(true);
    expect(box.querySelector('script')).toBeNull();
  });

  it('notices, Todos, and goals link their URLs', async () => {
    const g = await page(linkFleet(), { hash: '#notices' });
    expect(links(g.$('#notices'))).toEqual([ext('https://github.com/acme/web/pull/40')]);
    await g.go('#deck');
    expect(links(g.$('#daily-goals'))).toEqual([ext('https://github.com/acme/web/pull/41')]);
    const todos = g.$$('#deck section').find((s) => s.querySelector('h2')?.textContent === 'Todos')!;
    expect(links(todos)).toEqual([ext('https://docs.example/a'), ext('https://docs.example/b')]);
  });

  it('a cut deck note still links the whole URL', async () => {
    const d = linkFleet();
    const c = d.dispatches.find((x) => x.id.startsWith('cccccccc'))!;
    c.note = 'x'.repeat(70) + ' https://github.com/acme/web/pull/43/files';
    const g = await page(d);
    const flight = g.$$('#deck .deckgrid > section').find((s) => s.textContent?.startsWith('in flight'))!;
    const [link] = links(flight);
    expect(link![0]).toBe('https://github.com/acme/web/pull/43/files');
    expect(link![1]).toBe('https://github.com');
  });

  it('a decision links URLs in its detail and options; clicking an option link does not choose it', async () => {
    const d = everyAttentionFleet();
    d.attention = [
      { kind: 'decision', key: 'decision:0a1b2c3d', stateHash: 'h1', id: 'x', lane: 'work', verb: 'decision', ageSecs: 60, at: ago(60_000), standingSince: ago(60_000), note: 'Which plan?', repo: 'web' },
    ];
    d.decisions = [
      {
        key: 'decision:0a1b2c3d',
        title: 'Which plan? https://plans.example/1',
        detail: 'Compare http://127.0.0.1:5173/plan/a and [the doc](https://docs.example/plan), not `https://code.example`.',
        options: ['Plan A https://plans.example/a', 'Plan B'],
        attachments: [],
        lane: 'work',
        repo: 'web',
        askedBy: 'helm',
        askedAt: ago(60_000),
        stateHash: 'h1',
      },
    ];
    const g = await page(d);
    const row = g.$$('#deck .drow').find((r) => r.getAttribute('data-decision') === 'decision:0a1b2c3d')!;
    (row.querySelector('.dopen') as HTMLElement).click();
    await g.settle();
    const modal = g.$('.dmodal')!;
    expect(links(modal.querySelector('.dtop'))).toEqual([ext('https://plans.example/1')]);
    expect(links(modal.querySelector('.mdpage'))).toEqual([ext('http://127.0.0.1:5173/plan/a'), ext('https://docs.example/plan', 'the doc')]);
    expect(modal.querySelector('.mdpage code')!.textContent).toBe('https://code.example');
    const option = modal.querySelector('.dopt')!;
    expect(links(option)).toEqual([ext('https://plans.example/a')]);
    (option.querySelector('a') as HTMLElement).click();
    await g.settle();
    expect(g.$('.dmodal .dopt')!.getAttribute('aria-pressed')).toBe('false');
  });
});
