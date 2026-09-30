import { afterEach, describe, expect, it } from 'vitest';
import type { GlassSnapshot, TendAttention } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { lobItems } from '../src/glass-lobs.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, ago, emptyFleet, everyAttentionFleet } from './fixtures/glass-snapshots.js';

/**
 * The deck's decisions: a full-row card per framed decision (title, detail
 * as markdown, dispatch and repo, age, options, text box, attach control),
 * a plain card per raw question, one Send per card, the answered state, and
 * the `#decision/<key>` link the pet and the lobs open.
 */

const KEY = 'decision:0a1b2c3d';
const Q = 'work:bbbbbbbb-0000-4000-8000-000000000002';
const DISPATCH = 'aaaaaaaa-0000-4000-8000-000000000001';

function fleet(): GlassSnapshot {
  const d = emptyFleet();
  d.focusToken = 'tok';
  const decision: TendAttention = {
    kind: 'decision',
    key: KEY,
    stateHash: 'h1',
    id: DISPATCH,
    lane: 'work',
    verb: 'decision',
    ageSecs: 120,
    at: ago(2 * 60_000),
    standingSince: ago(2 * 60_000),
    note: 'Which schema should the tray use?',
    repo: 'web',
  };
  const question: TendAttention = {
    kind: 'question',
    key: Q,
    stateHash: 'h2',
    id: Q.slice(5),
    lane: 'work',
    verb: 'needs-decision',
    ageSecs: 600,
    at: ago(10 * 60_000),
    note: 'which port should the api bind?',
    repo: 'api',
  };
  d.attention = [question, decision];
  d.decisions = [
    {
      key: KEY,
      title: 'Which schema should the tray use?',
      detail: '# Context\n\nThe tray **fits** v2.\n\n![tray](tray.png)\n',
      options: ['v1', 'v2'],
      attachments: [
        { name: 'tray.png', path: '/home/.lobstah/decisions/0a1b2c3d/attachments/tray.png', bytes: 12, type: 'image/png' },
        { name: 'notes.txt', path: '/home/.lobstah/decisions/0a1b2c3d/attachments/notes.txt', bytes: 3, type: 'text/plain' },
      ],
      dispatch: DISPATCH,
      lane: 'work',
      repo: 'web',
      askedBy: 'helm',
      askedAt: ago(2 * 60_000),
      stateHash: 'h1',
    },
  ];
  d.answerLimits = { maxBytes: 1024, maxFiles: 8, textMax: 20_000, extensions: ['.png', '.txt'] };
  return d;
}

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
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const click = async (g: GlassDom, el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  (el as HTMLElement).click();
  await g.settle();
};
const card = (g: GlassDom, key: string) => g.$$('#deck .dcard').find((c) => c.getAttribute('data-decision') === key);

describe('glass: decision cards', () => {
  it('the decisions section comes first and lists cards newest first, full row', async () => {
    const g = await page(fleet());
    const first = g.$('#deck .deckgrid > section')!;
    expect(first.className).toBe('decisions');
    expect(text(first.querySelector('h2'))).toBe('decisions');
    expect(g.$$('#deck .dcards > .dcard').map((c) => c.getAttribute('data-decision'))).toEqual([KEY, Q]);
  });

  it('a decision with detail, options, and an attachment renders as a full card', async () => {
    const g = await page(fleet());
    const c = card(g, KEY)!;
    expect(c.className).toBe('dcard');
    expect(text(c.querySelector('.dtitle'))).toBe('Which schema should the tray use?');
    expect(text(c.querySelector('.dmeta'))).toBe('aaaaaaaa · web · 2m ago');
    const md = c.querySelector('.mdpage')!;
    expect(text(md.querySelector('h1'))).toBe('Context');
    expect(text(md.querySelector('strong'))).toBe('fits');
    expect(md.querySelector('img')!.getAttribute('src')).toBe(`/decision/${encodeURIComponent(KEY)}/files/tray.png`);
    expect(c.querySelector('.dfiles .dimg img')!.getAttribute('src')).toBe(`/decision/${encodeURIComponent(KEY)}/files/tray.png`);
    expect(text(c.querySelector('.dfiles .dfile'))).toContain('notes.txt');
    expect([...c.querySelectorAll('.doptions .dopt')].map(text)).toEqual(['v1', 'v2']);
    const box = c.querySelector('textarea.danswer') as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    expect(box.value).toBe('');
    const attach = c.querySelector('.dattach input[type="file"]')!;
    expect(attach.hasAttribute('multiple')).toBe(true);
    expect(attach.getAttribute('accept')).toBe('.png,.txt');
    expect(text(c.querySelector('.dsend'))).toBe('Send');
  });

  it("a raw question renders as a plain card: the worker's note, the text box, the attach control, no options", async () => {
    const g = await page(fleet());
    const c = card(g, Q)!;
    expect(c.className).toBe('dcard plain');
    expect(text(c.querySelector('.badge'))).toBe('needs-decision');
    expect(text(c.querySelector('.dtitle'))).toBe('which port should the api bind?');
    expect(c.querySelector('.doptions')).toBeNull();
    expect(c.querySelector('.mdpage')).toBeNull();
    expect(c.querySelector('textarea.danswer')).toBeTruthy();
    expect(c.querySelector('.dattach input[type="file"]')).toBeTruthy();
  });

  it('an option, text, and one Send post the answer; the card says what was chosen and leaves on the next refresh', async () => {
    const d = fleet();
    const g = await page(d, { post: () => ({ status: 201, body: { ok: true, id: 'r1', key: KEY } }) });
    await click(g, [...card(g, KEY)!.querySelectorAll('.dopt')].find((b) => text(b) === 'v2'));
    expect(card(g, KEY)!.querySelector('.dopt.on')!.textContent).toBe('v2');
    const box = card(g, KEY)!.querySelector('textarea') as HTMLTextAreaElement;
    box.value = 'keep v1 readable\nfor a week';
    box.dispatchEvent(new (g.window as unknown as { Event: typeof Event }).Event('input'));
    await g.settle();
    await click(g, card(g, KEY)!.querySelector('.dsend'));
    const [sent] = g.posts();
    expect(sent!.url).toBe('/requests');
    expect(sent!.headers['x-lobstah-token']).toBe('tok');
    expect(JSON.parse(sent!.body)).toEqual({
      kind: 'decision-answer',
      payload: { key: KEY, option: 'v2', text: 'keep v1 readable\nfor a week', files: [] },
    });
    expect(text(card(g, KEY)!.querySelector('.danswered'))).toBe('answered · v2 · keep v1 readable');
    expect(card(g, KEY)!.querySelector('textarea')).toBeNull();
    // The next snapshot no longer carries it.
    d.attention = d.attention.filter((a) => a.key !== KEY);
    d.decisions = [];
    g.serve(d);
    await g.poll();
    expect(card(g, KEY)).toBeUndefined();
    expect(card(g, Q)).toBeTruthy();
  });

  it("a raw question's text alone is the answer; a refusal shows the server's reason and keeps the text", async () => {
    const g = await page(fleet(), { post: () => ({ status: 404, body: { ok: false, reason: 'no standing decision or question' } }) });
    const box = card(g, Q)!.querySelector('textarea') as HTMLTextAreaElement;
    box.value = '8080';
    box.dispatchEvent(new (g.window as unknown as { Event: typeof Event }).Event('input'));
    await g.settle();
    await click(g, card(g, Q)!.querySelector('.dsend'));
    expect(g.posts()[0]!.url).toBe('/requests');
    expect(JSON.parse(g.posts()[0]!.body)).toEqual({ kind: 'decision-answer', payload: { key: Q, text: '8080', files: [] } });
    expect(text(card(g, Q)!.querySelector('.derr'))).toBe('no standing decision or question');
    expect((card(g, Q)!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('8080');
  });

  it('an empty answer is not sent', async () => {
    const g = await page(fleet());
    await click(g, card(g, KEY)!.querySelector('.dsend'));
    expect(g.posts()).toEqual([]);
    expect(text(card(g, KEY)!.querySelector('.derr'))).toContain('Choose an option');
  });

  it('#decision/<key> opens the deck and marks that card', async () => {
    const g = await page(fleet(), { hash: `#decision/${encodeURIComponent(KEY)}` });
    expect(g.$('.tabpage.on')!.id).toBe('page-deck');
    expect(card(g, KEY)!.className).toContain('focus');
    expect(card(g, Q)!.className).not.toContain('focus');
  });

  it('an empty fleet says none', async () => {
    const g = await page(emptyFleet());
    expect(text(g.$('#deck .decisions .empty'))).toBe('none');
  });
});

describe('glass: decision lobs', () => {
  it('a decision lob shows its title only and links to its card', () => {
    const [lob] = lobItems([{ kind: 'decision', key: KEY, stateHash: 'h1', id: DISPATCH, lane: 'work', verb: 'decision', note: 'Cut 0.6.0?' }], {
      lobs: true,
      preview: false,
    });
    expect(lob).toMatchObject({ text: 'Cut 0.6.0?', label: '', hash: `#decision/${encodeURIComponent(KEY)}` });
    expect(lob!.href).toBeUndefined();
  });
});

describe('glass: the image overlay', () => {
  const overlay = (g: GlassDom) => g.$('#lightbox');
  const escape = async (g: GlassDom) => {
    g.document.dispatchEvent(new (g.window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', { key: 'Escape' }));
    await g.settle();
  };
  const imgSrc = `/decision/${encodeURIComponent(KEY)}/files/tray.png`;

  it('a decision image opens in the page, centered over a backdrop, with a link to the original; no new window', async () => {
    const g = await page(fleet());
    const c = card(g, KEY)!;
    expect(c.querySelector('a[target="_blank"] img')).toBeNull();
    expect(overlay(g)).toBeNull();
    await click(g, c.querySelector('.dfiles .dimg'));
    const box = overlay(g)!;
    expect(box).toBeTruthy();
    expect(box.querySelector('img.lbimg')!.getAttribute('src')).toBe(imgSrc);
    const original = box.querySelector('a.lboriginal')!;
    expect(original.getAttribute('href')).toBe(imgSrc);
    expect(original.getAttribute('target')).toBe('_blank');
    expect(box.querySelector('button.lbclose')).toBeTruthy();
  });

  it('closes on Escape, on a click on the backdrop, and on the close button, but not on a click on the image', async () => {
    const g = await page(fleet());
    const open = () => click(g, card(g, KEY)!.querySelector('.dfiles .dimg'));
    await open();
    await escape(g);
    expect(overlay(g)).toBeNull();
    await open();
    await click(g, overlay(g)!.querySelector('img.lbimg'));
    expect(overlay(g)).toBeTruthy();
    await click(g, overlay(g));
    expect(overlay(g)).toBeNull();
    await open();
    await click(g, overlay(g)!.querySelector('button.lbclose'));
    expect(overlay(g)).toBeNull();
    // The detail page's image opens the same overlay.
    await click(g, card(g, KEY)!.querySelector('.mdpage .mdimg'));
    expect(overlay(g)!.querySelector('img.lbimg')!.getAttribute('src')).toBe(imgSrc);
  });

  it("report pages and the dispatch modal's attachments use the same overlay; Escape closes it before the modal", async () => {
    const reportKey = 'report:work:cccccccc-0000-4000-8000-000000000003';
    const g = await page(everyAttentionFleet(), {
      files: { [`/report/${encodeURIComponent(reportKey)}/md`]: '# Tray findings\n\n![the tray](tray.png)\n' },
    });
    await g.go('#dispatches');
    await click(g, g.$$('#dispatches tr.rowhead').find((tr) => text(tr).includes('cccccccc')));
    expect(g.$('#overlay')!.className).toBe('open');
    // The report page's image.
    await click(g, g.$('#modalbox .mdpage .mdimg'));
    expect(overlay(g)!.querySelector('img')!.getAttribute('src')).toBe(`/report/${encodeURIComponent(reportKey)}/files/tray.png`);
    await escape(g);
    expect(overlay(g)).toBeNull();
    expect(g.$('#overlay')!.className).toBe('open');
    // The dispatch's own attachment.
    const thumbs = g.$$('#modalbox button.thumb');
    const shot = thumbs.find((b) => b.querySelector('img')!.getAttribute('src')!.endsWith('/shot.png'))!;
    expect(shot.querySelector('img')!.getAttribute('src')).toBe('/attachment/dispatch/work/cccccccc-0000-4000-8000-000000000003/shot.png');
    await click(g, shot);
    expect(overlay(g)!.querySelector('img')!.getAttribute('src')).toBe('/attachment/dispatch/work/cccccccc-0000-4000-8000-000000000003/shot.png');
    // The modal stays open under it.
    expect(g.$('#overlay')!.className).toBe('open');
    await escape(g);
    expect(overlay(g)).toBeNull();
    expect(g.$('#overlay')!.className).toBe('open');
  });
});

describe('glass: pasting into the answer box', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
  type Item = { kind: string; type: string; getAsFile: () => File | null; getAsString?: (cb: (s: string) => void) => void };
  const paste = async (g: GlassDom, key: string, items: Item[]) => {
    const w = g.window as unknown as { Event: typeof Event };
    const ev = new w.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { items, types: items.map((i) => i.type) } });
    card(g, key)!.querySelector('textarea')!.dispatchEvent(ev);
    await g.settle();
    return ev;
  };
  const image = (g: GlassDom, bytes: number[], type = 'image/png'): Item => {
    const W = g.window as unknown as { File: typeof File };
    return { kind: 'file', type, getAsFile: () => new W.File([new Uint8Array(bytes)], 'image.png', { type }) };
  };
  const textItem: Item = { kind: 'string', type: 'text/plain', getAsFile: () => null };

  it('a pasted image becomes an attachment named pasted-<time>.png, listed with picked files, and is sent', async () => {
    const d = fleet();
    d.answerLimits = { maxBytes: 1024, maxFiles: 8, textMax: 20_000, extensions: ['.png', '.txt'] };
    const g = await page(d, { post: () => ({ status: 201, body: { ok: true, id: 'r1', key: Q } }) });
    const ev = await paste(g, Q, [image(g, PNG), textItem]);
    // Text still pastes as text: the box's own paste is not prevented.
    expect(ev.defaultPrevented).toBe(false);
    const chips = card(g, Q)!.querySelectorAll('.dfoot .dchip');
    expect(chips).toHaveLength(1);
    const name = (chips[0]!.firstChild as Text).textContent!;
    expect(name).toMatch(/^pasted-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.png$/);
    await click(g, card(g, Q)!.querySelector('.dsend'));
    const body = JSON.parse(g.posts()[0]!.body) as { payload: { files: Array<{ name: string; data: string }> } };
    expect(body.payload.files).toHaveLength(1);
    expect(body.payload.files[0]!.name).toBe(name);
    expect(Buffer.from(body.payload.files[0]!.data, 'base64')).toEqual(Buffer.from(PNG));
  });

  it('a text-only paste adds nothing; an oversized image is refused with the same check as a picked file', async () => {
    const g = await page(fleet());
    await paste(g, Q, [textItem]);
    expect(card(g, Q)!.querySelectorAll('.dchip')).toHaveLength(0);
    expect(card(g, Q)!.querySelector('.derr')).toBeNull();
    await paste(g, Q, [image(g, [...PNG, ...new Array(2000).fill(0)])]);
    expect(card(g, Q)!.querySelectorAll('.dchip')).toHaveLength(0);
    expect(text(card(g, Q)!.querySelector('.derr'))).toMatch(/^pasted-.*\.png: larger than 1024 bytes$/);
  });
});
