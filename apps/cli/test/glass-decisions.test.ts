import * as fs from 'node:fs';
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
/** The decision modal, when it shows `key`. */
const card = (g: GlassDom, key: string) => g.$$('.dmodal').find((c) => c.getAttribute('data-decision') === key);
/** The deck's row for `key`. */
const row = (g: GlassDom, key: string) => g.$$('#deck .drow').find((c) => c.getAttribute('data-decision') === key);
/** Open the decision modal at `key` from its row. */
const show = async (g: GlassDom, key: string) => {
  if (!row(g, key)) await g.go('#deck');
  await click(g, row(g, key)!.querySelector('.dopen'));
  expect(card(g, key)).toBeTruthy();
};
/** The answers the page posted (not its view records). */
const answers = (g: GlassDom) => g.posts().filter((p) => (JSON.parse(p.body) as { kind: string }).kind === 'decision-answer');
const views = (g: GlassDom) => g.posts().filter((p) => (JSON.parse(p.body) as { kind: string }).kind === 'decision-viewed').map((p) => (JSON.parse(p.body) as { payload: { key: string } }).payload.key);
const key = async (g: GlassDom, k: string, target?: Element | null) => {
  const W = g.window as unknown as { KeyboardEvent: typeof KeyboardEvent };
  (target ?? g.document).dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true }));
  await g.settle();
};
const type = async (g: GlassDom, box: Element, value: string) => {
  (box as HTMLTextAreaElement).value = value;
  box.dispatchEvent(new (g.window as unknown as { Event: typeof Event }).Event('input'));
  await g.settle();
};
const ok = () => ({ status: 201, body: { ok: true, id: 'r1' } });

describe('glass: the decisions list', () => {
  it('the decisions section comes first: one compact row per open decision, newest first, no answering in the list', async () => {
    const g = await page(fleet());
    const first = g.$('#deck .deckgrid > section')!;
    expect(first.className).toBe('decisions');
    expect(g.$$('#deck .dlist > .drow').map((c) => c.getAttribute('data-decision'))).toEqual([KEY, Q]);
    const r = row(g, KEY)!;
    expect(text(r.querySelector('.dtitle'))).toBe('Which schema should the tray use?');
    expect(text(r.querySelector('.dmeta'))).toBe('aaaaaaaa · web');
    expect(text(r.querySelector('.dage'))).toBe('2m ago');
    expect(text(r.querySelector('.dstate'))).toBe('unread');
    expect(r.className).toContain('unread');
    expect(text(row(g, Q)!.querySelector('.badge'))).toBe('needs-decision');
    expect(g.$('#deck textarea')).toBeNull();
    expect(g.$('#deck .dsend')).toBeNull();
  });

  it('a decision viewed before is read; the unread count is on the heading and the deck tab', async () => {
    const d = fleet();
    d.decisions[0]!.viewedAt = ago(60_000);
    const g = await page(d);
    expect(text(row(g, KEY)!.querySelector('.dstate'))).toBe('read');
    expect(row(g, KEY)!.className).not.toContain('unread');
    expect(row(g, Q)!.className).toContain('unread');
    expect(text(g.$('#deck .decisions h2 .dbadge'))).toBe('1');
    const badge = g.$('#tabs a[data-tab="deck"] .dbadge')!;
    expect(text(badge)).toBe('1');
    expect(badge.getAttribute('aria-label')).toBe('1 new decision');
  });

  it('an empty fleet says none, with no badge and no alert', async () => {
    const g = await page(emptyFleet());
    expect(text(g.$('#deck .decisions .empty'))).toBe('none');
    expect(g.$('.dbadge')).toBeNull();
    expect(g.$('.dalert')).toBeNull();
  });
});

describe('glass: the decision modal', () => {
  it('a row opens the full decision: detail, files, options, text, attach, Send, its position; viewing records it once and answers nothing', async () => {
    const g = await page(fleet(), { post: ok });
    await show(g, KEY);
    const c = card(g, KEY)!;
    expect(c.getAttribute('role')).toBe('dialog');
    expect(c.getAttribute('aria-modal')).toBe('true');
    expect(text(g.$('#' + c.getAttribute('aria-labelledby')!))).toBe('Which schema should the tray use?');
    expect(text(c.querySelector('.dtitle'))).toBe('Which schema should the tray use?');
    expect(text(c.querySelector('.dmeta'))).toBe('aaaaaaaa · web · 2m ago');
    const md = c.querySelector('.mdpage')!;
    expect(text(md.querySelector('h1'))).toBe('Context');
    expect(md.querySelector('img')!.getAttribute('src')).toBe(`/decision/${encodeURIComponent(KEY)}/files/tray.png`);
    expect(text(c.querySelector('.dfiles .dfile'))).toContain('notes.txt');
    expect([...c.querySelectorAll('.doptions .dopt .dlabel')].map(text)).toEqual(['v1', 'v2']);
    expect((c.querySelector('textarea.danswer') as HTMLTextAreaElement).value).toBe('');
    expect(c.querySelector('.dattach input[type="file"]')!.getAttribute('accept')).toBe('.png,.txt');
    expect(text(c.querySelector('.dsend'))).toBe('Send');
    // Oldest first: the question (10m), then this decision (2m).
    expect(text(c.querySelector('.dpos'))).toBe('2 of 2');
    expect(views(g)).toEqual([KEY]);
    expect(answers(g)).toEqual([]);
    expect(text(row(g, KEY)!.querySelector('.dstate'))).toBe('read');
    // Closing and opening again records nothing more.
    await key(g, 'Escape');
    expect(card(g, KEY)).toBeUndefined();
    await show(g, KEY);
    expect(views(g)).toEqual([KEY]);
  });

  it('previous and next step oldest first, with buttons and arrow keys; arrows in the text box stay there; nothing is sent', async () => {
    const g = await page(fleet(), { post: ok });
    await show(g, Q);
    expect(text(card(g, Q)!.querySelector('.dpos'))).toBe('1 of 2');
    expect((card(g, Q)!.querySelector('.dprev') as HTMLButtonElement).disabled).toBe(true);
    await click(g, card(g, Q)!.querySelector('.dnext'));
    expect(text(card(g, KEY)!.querySelector('.dpos'))).toBe('2 of 2');
    expect((card(g, KEY)!.querySelector('.dnext') as HTMLButtonElement).disabled).toBe(true);
    await key(g, 'ArrowLeft');
    expect(card(g, Q)).toBeTruthy();
    await key(g, 'ArrowRight');
    expect(card(g, KEY)).toBeTruthy();
    await key(g, 'ArrowRight'); // the last one: it stays
    expect(card(g, KEY)).toBeTruthy();
    const box = card(g, KEY)!.querySelector('textarea')!;
    await type(g, box, 'half an answer');
    await key(g, 'ArrowLeft', box);
    expect(card(g, KEY)).toBeTruthy();
    expect(answers(g)).toEqual([]);
    expect(views(g)).toEqual([Q, KEY]);
    // The typed text stays with its decision while the modal moves.
    await click(g, card(g, KEY)!.querySelector('.dprev'));
    await click(g, card(g, Q)!.querySelector('.dnext'));
    expect((card(g, KEY)!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('half an answer');
  });

  it('a sent answer loads the next open decision; after the last, the all-answered state closes on the next click', async () => {
    const d = fleet();
    const g = await page(d, { post: ok });
    await show(g, Q);
    await type(g, card(g, Q)!.querySelector('textarea')!, '8080');
    await click(g, card(g, Q)!.querySelector('.dsend'));
    expect(JSON.parse(answers(g)[0]!.body)).toEqual({ kind: 'decision-answer', payload: { key: Q, text: '8080', files: [] } });
    // The next open one loads; the answered one left the order.
    expect(card(g, KEY)).toBeTruthy();
    expect(text(card(g, KEY)!.querySelector('.dpos'))).toBe('1 of 1');
    expect(text(row(g, Q)!.querySelector('.dstate'))).toBe('answered · 8080');
    await click(g, [...card(g, KEY)!.querySelectorAll('.dopt')].find((b) => text(b.querySelector('.dlabel')) === 'v2'));
    await click(g, card(g, KEY)!.querySelector('.dsend'));
    expect(JSON.parse(answers(g)[1]!.body)).toEqual({ kind: 'decision-answer', payload: { key: KEY, option: 'v2', files: [] } });
    const done = g.$('.dmodal .ddone')!;
    expect(text(done)).toContain('All decisions answered');
    await click(g, done);
    expect(g.$('.dmodal')).toBeNull();
    // The next snapshot no longer carries them.
    d.attention = [];
    d.decisions = [];
    g.serve(d);
    await g.poll();
    expect(g.$$('#deck .drow')).toEqual([]);
  });

  it("a failed send keeps the decision and the typed text, and shows the server's reason", async () => {
    const g = await page(fleet(), { post: (url, init) => ((JSON.parse(init.body) as { kind: string }).kind === 'decision-answer' ? { status: 404, body: { ok: false, reason: 'no standing decision or question' } } : ok()) });
    await show(g, Q);
    await type(g, card(g, Q)!.querySelector('textarea')!, '8080');
    await click(g, card(g, Q)!.querySelector('.dsend'));
    expect(card(g, Q)).toBeTruthy();
    expect(text(card(g, Q)!.querySelector('.derr'))).toBe('no standing decision or question');
    expect((card(g, Q)!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('8080');
  });

  it('an empty answer is not sent', async () => {
    const g = await page(fleet(), { post: ok });
    await show(g, KEY);
    await click(g, card(g, KEY)!.querySelector('.dsend'));
    expect(answers(g)).toEqual([]);
    expect(text(card(g, KEY)!.querySelector('.derr'))).toContain('Choose an option');
  });

  it('a raw question shows its badge and note, the text box and attach control, and no options', async () => {
    const g = await page(fleet(), { post: ok });
    await show(g, Q);
    const c = card(g, Q)!;
    expect(text(c.querySelector('.badge'))).toBe('needs-decision');
    expect(text(c.querySelector('.dtitle'))).toBe('which port should the api bind?');
    expect(c.querySelector('.doptions')).toBeNull();
    expect(c.querySelector('.mdpage')).toBeNull();
    expect(c.querySelector('.dattach input[type="file"]')).toBeTruthy();
  });

  it('Tab stays inside the modal; closing gives focus back', async () => {
    const g = await page(fleet(), { post: ok });
    await g.go('#deck');
    const opener = row(g, KEY)!.querySelector('.dopen') as HTMLElement;
    opener.focus();
    await click(g, opener);
    const c = card(g, KEY)!;
    expect(g.document.activeElement).toBe(c);
    const focusables = [...c.querySelectorAll('button:not([disabled]), textarea, input')] as HTMLElement[];
    const W = g.window as unknown as { KeyboardEvent: typeof KeyboardEvent };
    const tab = new W.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    focusables.at(-1)!.focus();
    c.dispatchEvent(tab);
    await g.settle();
    expect(tab.defaultPrevented).toBe(true);
    expect(g.document.activeElement).toBe(focusables[0]);
    await key(g, 'Escape');
    expect(g.document.activeElement).toBe(opener);
  });

  it('#decision/<key> opens the deck, marks that row, and opens it in the modal', async () => {
    const g = await page(fleet(), { hash: `#decision/${encodeURIComponent(KEY)}`, post: ok });
    expect(g.$('.tabpage.on')!.id).toBe('page-deck');
    expect(row(g, KEY)!.className).toContain('focus');
    expect(row(g, Q)!.className).not.toContain('focus');
    expect(card(g, KEY)).toBeTruthy();
  });

  it('a decision lob opens its decision over any tab and flashes its row', async () => {
    const g = await page(fleet(), { hash: '#prs', post: ok });
    const lob = g.$$('#lobs a.lob').find((l) => l.getAttribute('href') === `#decision/${encodeURIComponent(KEY)}`)!;
    expect(lob).toBeTruthy();
    await click(g, lob);
    expect(g.$('.tabpage.on')!.id).toBe('page-deck');
    expect(row(g, KEY)!.className).toContain('focus');
    expect(card(g, KEY)).toBeTruthy();
    expect(g.$('#overlay')!.className).not.toBe('open');
  });
});

describe('glass: decision hotkeys', () => {
  type KeyOpts = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean };
  const press = async (g: GlassDom, opts: KeyOpts, target?: Element | null) => {
    const W = g.window as unknown as { KeyboardEvent: typeof KeyboardEvent };
    const ev = new W.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts });
    (target ?? g.document.activeElement ?? g.document.body).dispatchEvent(ev);
    await g.settle();
    return ev;
  };
  const shown = (g: GlassDom) => g.$('.dmodal')?.getAttribute('data-decision');

  it('d opens the decision modal at the oldest unread decision, else the oldest open one; with none open it does nothing', async () => {
    const d = fleet();
    // The question (10m) is the oldest; once viewed, d goes to the oldest unread one instead.
    d.attention = d.attention.map((a) => (a.key === Q ? { ...a, viewedAt: ago(60_000) } : a));
    const g = await page(d, { hash: '#prs', post: ok });
    await press(g, { key: 'd' });
    expect(shown(g)).toBe(KEY);
    await key(g, 'Escape');
    // Every one viewed: the oldest open one.
    d.decisions = d.decisions.map((x) => ({ ...x, viewedAt: ago(30_000) }));
    g.serve(d);
    await g.poll();
    await press(g, { key: 'd' });
    expect(shown(g)).toBe(Q);
    // None open: nothing happens.
    const empty = await page(emptyFleet(), { post: ok });
    await press(empty, { key: 'd' });
    expect(empty.$('.dmodal')).toBeNull();
    expect(empty.$('#overlay')!.className).not.toBe('open');
  });

  it('d is ignored while typing in a field, with cmd/ctrl/alt held, during IME composition, and under another modal', async () => {
    const g = await page(everyAttentionFleet(), { post: ok });
    const search = g.$('input[type="search"], .controls input[type="text"], .controls input')!;
    expect(search).toBeTruthy();
    await press(g, { key: 'd' }, search);
    expect(g.$('.dmodal')).toBeNull();
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }]) {
      const ev = await press(g, { key: 'd', ...mod });
      expect(ev.defaultPrevented).toBe(false);
      expect(g.$('.dmodal')).toBeNull();
    }
    await g.go('#traps');
    await click(g, g.$$('#traps tr.rowhead').find((tr) => text(tr).includes('wt:t1')));
    expect(g.$('#overlay')!.className).toBe('open');
    await press(g, { key: 'd' });
    expect(g.$('.dmodal')).toBeNull();
    expect(g.$('#overlay')!.className).toBe('open');
  });

  it('a number selects that option and focuses it without sending; the next number focuses the text field; hints show 1..N and N+1', async () => {
    const g = await page(fleet(), { post: ok });
    await show(g, KEY);
    const c = card(g, KEY)!;
    expect([...c.querySelectorAll('.dopt .dkey')].map(text)).toEqual(['1', '2']);
    expect([...c.querySelectorAll('.dopt')].map((b) => b.getAttribute('aria-keyshortcuts'))).toEqual(['1', '2']);
    expect(text(c.querySelector('.danswer-wrap .dkey'))).toBe('3');
    expect(c.querySelector('textarea')!.getAttribute('aria-keyshortcuts')).toBe('3');
    expect(text(c.querySelector('.dlegend'))).toContain('Enter on a chosen option sends');
    await press(g, { key: '2' });
    expect(text(card(g, KEY)!.querySelector('.dopt.on .dlabel'))).toBe('v2');
    expect(g.document.activeElement).toBe(card(g, KEY)!.querySelector('.dopt.on'));
    // Pressing it again keeps it chosen: a number selects, it never toggles or sends.
    await press(g, { key: '2' }, g.$('.dmodal'));
    expect(text(card(g, KEY)!.querySelector('.dopt.on .dlabel'))).toBe('v2');
    expect(answers(g)).toEqual([]);
    await press(g, { key: '3' }, g.$('.dmodal'));
    expect(g.document.activeElement).toBe(card(g, KEY)!.querySelector('textarea'));
    // Numbers typed in the text field are text, not keys.
    const box = card(g, KEY)!.querySelector('textarea')!;
    const typed = await press(g, { key: '1' }, box);
    expect(typed.defaultPrevented).toBe(false);
    expect(text(card(g, KEY)!.querySelector('.dopt.on .dlabel'))).toBe('v2');
    expect(answers(g)).toEqual([]);
    // A raw question has no options: 1 is its text field.
    await key(g, 'Escape');
    await key(g, 'Escape');
    await show(g, Q);
    expect(text(card(g, Q)!.querySelector('.danswer-wrap .dkey'))).toBe('1');
    await press(g, { key: '1' }, g.$('.dmodal'));
    expect(g.document.activeElement).toBe(card(g, Q)!.querySelector('textarea'));
  });

  it('Enter on the selected option sends it and the next decision loads; arrows still step; Esc leaves the text field, then closes', async () => {
    const g = await page(fleet(), { post: ok });
    await show(g, KEY);
    // Arrows step as before, and number keys do not change that.
    await press(g, { key: 'ArrowLeft' }, g.$('.dmodal'));
    expect(shown(g)).toBe(Q);
    await press(g, { key: 'ArrowRight' }, g.$('.dmodal'));
    expect(shown(g)).toBe(KEY);
    // Enter with nothing chosen sends nothing.
    await press(g, { key: 'Enter' }, g.$('.dmodal'));
    expect(answers(g)).toEqual([]);
    await press(g, { key: '1' }, g.$('.dmodal'));
    const ev = await press(g, { key: 'Enter' });
    expect(ev.defaultPrevented).toBe(true);
    expect(JSON.parse(answers(g)[0]!.body)).toEqual({ kind: 'decision-answer', payload: { key: KEY, option: 'v1', files: [] } });
    // The next open one loaded.
    expect(shown(g)).toBe(Q);
    // Esc in the text field leaves it first; the modal stays.
    await press(g, { key: '1' }, g.$('.dmodal'));
    const box = card(g, Q)!.querySelector('textarea')!;
    expect(g.document.activeElement).toBe(box);
    await key(g, 'Escape', box);
    expect(g.document.activeElement).not.toBe(box);
    expect(shown(g)).toBe(Q);
    await key(g, 'Escape');
    expect(g.$('.dmodal')).toBeNull();
  });

  it('more than nine options: keys and hints cover the first nine only, and the text field has no key', async () => {
    const d = fleet();
    const options = Array.from({ length: 11 }, (_, i) => `o${i + 1}`);
    d.decisions = d.decisions.map((x) => ({ ...x, options }));
    const g = await page(d, { post: ok });
    await show(g, KEY);
    const c = card(g, KEY)!;
    expect([...c.querySelectorAll('.dopt .dkey')].map(text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(c.querySelector('.danswer-wrap .dkey')).toBeNull();
    expect(c.querySelector('textarea')!.hasAttribute('aria-keyshortcuts')).toBe(false);
    await press(g, { key: '9' }, g.$('.dmodal'));
    expect(text(card(g, KEY)!.querySelector('.dopt.on .dlabel'))).toBe('o9');
    expect(answers(g)).toEqual([]);
  });
});

describe('glass: the new-decision alert', () => {
  it('counts the unread decisions on any tab, politely, without taking focus; a click opens the oldest unread', async () => {
    const d = fleet();
    d.decisions[0]!.viewedAt = ago(30_000);
    const g = await page(d, { hash: '#prs', post: ok });
    const live = g.$('.dalert-live')!;
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(text(g.$('.dalert .dalert-open'))).toBe('1 1 new decision');
    expect(g.$('.dalert .dcount')!.getAttribute('aria-hidden')).toBe('true');
    expect(g.document.activeElement).toBe(g.document.body);
    await click(g, g.$('.dalert .dalert-open'));
    expect(card(g, Q)).toBeTruthy();
    expect(g.$('.dalert')).toBeNull();
  });

  it('dismissing hides it and marks nothing read; a new decision shows it again with the new count', async () => {
    const d = fleet();
    const g = await page(d, { hash: '#traps', post: ok });
    expect(text(g.$('.dalert .dalert-open'))).toBe('2 2 new decisions');
    await click(g, g.$('.dalert .dx'));
    expect(g.$('.dalert')).toBeNull();
    expect(views(g)).toEqual([]);
    expect(text(g.$('#tabs a[data-tab="deck"] .dbadge'))).toBe('2');
    // The same decisions on the next poll: still dismissed.
    await g.poll();
    expect(g.$('.dalert')).toBeNull();
    // A new one arrives (a replace: a new key, unread).
    const NEW = 'decision:99999999';
    d.attention = [...d.attention, { ...d.attention.find((a) => a.key === KEY)!, key: NEW, at: ago(1000), standingSince: ago(1000) }];
    d.decisions = [...d.decisions, { ...d.decisions[0]!, key: NEW, title: 'A newer question', askedAt: ago(1000) }];
    g.serve(d);
    await g.poll();
    expect(text(g.$('.dalert .dalert-open'))).toBe('3 3 new decisions');
  });

  it('stays behind an open trap modal or decision modal, never taking focus, and is there again when they close', async () => {
    const d = everyAttentionFleet();
    const g = await page(d, { post: ok });
    const count = () => Number(text(g.$('.dalert .dcount')));
    const before = count();
    expect(before).toBeGreaterThan(1);
    await g.go('#traps');
    await click(g, g.$$('#traps tr.rowhead').find((tr) => text(tr).includes('wt:t1')));
    // The trap modal is open; the alert is still rendered (its layer is below the modal's) and has not taken focus.
    expect(g.$('#overlay')!.className).toBe('open');
    expect(g.$('.dalert')).toBeTruthy();
    expect(g.$('.dalert')!.contains(g.document.activeElement)).toBe(false);
    // The decision modal opens over the trap modal; the alert stays behind both, its count one less.
    const first = g.$$('#lobs a.lob').map((l) => l.getAttribute('href')!).find((h) => h.startsWith('#decision/'))!;
    await g.go(first);
    expect(g.$('.dmodal')).toBeTruthy();
    expect(g.$('#overlay')!.className).toBe('open');
    expect(g.$('.dalert')).toBeTruthy();
    expect(count()).toBe(before - 1);
    expect(g.$('.dalert')!.contains(g.document.activeElement)).toBe(false);
    // Escape closes the decision modal first, then the trap modal; the alert is still there.
    await key(g, 'Escape');
    expect(g.$('.dmodal')).toBeNull();
    expect(g.$('#overlay')!.className).toBe('open');
    await key(g, 'Escape');
    expect(g.$('#overlay')!.className).not.toBe('open');
    expect(g.$('.dalert')).toBeTruthy();
  });

  it("is layered below every modal and backdrop by the stylesheet's layer tokens", () => {
    const css = fs.readFileSync(new URL('../glass/glass.css', import.meta.url), 'utf8');
    const zOf = (sel: string) => {
      const at = css.indexOf(`\n${sel} {`);
      expect(at).toBeGreaterThanOrEqual(0);
      return /z-index: ([^;]+);/.exec(css.slice(at, css.indexOf('}', at)))?.[1]?.trim();
    };
    expect(zOf('.dalert-live')).toBe('var(--layer-alert)');
    expect(zOf('#overlay')).toBe('var(--layer-modal)');
    expect(zOf('#doverlay')).toBe('var(--layer-decision-modal)');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const token = (name: string) => new RegExp(`--${name}: ([^;]+);`).exec(root)?.[1];
    expect(token('layer-alert')).toBe('calc(var(--layer-modal) - 1)');
    expect(Number(token('layer-decision-modal'))).toBeGreaterThan(Number(token('layer-modal')));
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
    const g = await page(fleet(), { post: ok });
    await show(g, KEY);
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
    const g = await page(fleet(), { post: ok });
    await show(g, KEY);
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

  it('a report page opens its image in the same overlay; Escape closes it', async () => {
    const reportKey = 'report:work:cccccccc-0000-4000-8000-000000000003';
    const fleet = everyAttentionFleet();
    const row = (fleet.reports ?? []).find((r) => r.key === reportKey)!;
    const k = encodeURIComponent(reportKey);
    const g = await page(fleet, {
      path: `/report/${k}`,
      files: { [`/report/${k}/md`]: '# Tray findings\n\n![the tray](tray.png)\n', [`/report/${k}/meta`]: JSON.stringify(row) },
    });
    await click(g, g.$('.reportview .mdpage .mdimg'));
    expect(overlay(g)!.querySelector('img')!.getAttribute('src')).toBe(`/report/${k}/files/tray.png`);
    await escape(g);
    expect(overlay(g)).toBeNull();
    expect(text(g.$('.reportview h1'))).toBe('Tray findings');
  });

  it("the dispatch modal's attachments use the same overlay; Escape closes it before the modal", async () => {
    const g = await page(everyAttentionFleet());
    await g.go('#dispatches');
    await click(g, g.$$('#dispatches tr.rowhead').find((tr) => text(tr).includes('cccccccc')));
    expect(g.$('#overlay')!.className).toBe('open');
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

  it('opens a trap attachment in the same overlay without closing the trap modal', async () => {
    const g = await page(everyAttentionFleet());
    await g.go('#traps');
    await click(g, g.$$('#traps tr.rowhead').find((tr) => text(tr).includes('wt:t1')));
    await click(g, g.$('#modalbox button.thumb'));
    expect(overlay(g)!.querySelector('img.lbimg')!.getAttribute('src')).toBe('/attachment/trap/t1/a.png');
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
    if (!card(g, key)) await show(g, key);
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
    const body = JSON.parse(answers(g)[0]!.body) as { payload: { files: Array<{ name: string; data: string }> } };
    expect(body.payload.files).toHaveLength(1);
    expect(body.payload.files[0]!.name).toBe(name);
    expect(Buffer.from(body.payload.files[0]!.data, 'base64')).toEqual(Buffer.from(PNG));
  });

  it('a text-only paste adds nothing; an oversized image is refused with the same check as a picked file', async () => {
    const g = await page(fleet(), { post: ok });
    await paste(g, Q, [textItem]);
    expect(card(g, Q)!.querySelectorAll('.dchip')).toHaveLength(0);
    expect(card(g, Q)!.querySelector('.derr')).toBeNull();
    await paste(g, Q, [image(g, [...PNG, ...new Array(2000).fill(0)])]);
    expect(card(g, Q)!.querySelectorAll('.dchip')).toHaveLength(0);
    expect(text(card(g, Q)!.querySelector('.derr'))).toMatch(/^pasted-.*\.png: larger than 1024 bytes$/);
  });

  it('multiple pasted images retain their format and obey the attachment count limit', async () => {
    const d = fleet();
    d.answerLimits = { maxBytes: 1024, maxFiles: 2, textMax: 20_000, extensions: ['.png', '.jpg'] };
    const g = await page(d, { post: () => ({ status: 201, body: { ok: true, id: 'r1', key: Q } }) });
    await paste(g, Q, [image(g, PNG), image(g, [0xff, 0xd8, 0xff], 'image/jpeg'), image(g, PNG)]);
    expect(card(g, Q)!.querySelectorAll('.dchip')).toHaveLength(2);
    expect(text(card(g, Q)!.querySelector('.derr'))).toContain('at most 2 files');
    await click(g, card(g, Q)!.querySelector('.dsend'));
    const body = JSON.parse(answers(g)[0]!.body) as { payload: { files: Array<{ name: string; data: string }> } };
    expect(body.payload.files.map((f) => f.name)).toEqual([expect.stringMatching(/-1\.png$/), expect.stringMatching(/-2\.jpg$/)]);
    expect(Buffer.from(body.payload.files[1]!.data, 'base64')).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('refuses a pasted image type not allowed by the answer limits', async () => {
    const g = await page(fleet(), { post: ok });
    await paste(g, KEY, [image(g, [0xff, 0xd8, 0xff], 'image/jpeg')]);
    expect(card(g, KEY)!.querySelectorAll('.dchip')).toHaveLength(0);
    expect(text(card(g, KEY)!.querySelector('.derr'))).toContain('.jpg: type not accepted');
  });
});
