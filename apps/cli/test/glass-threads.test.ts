import { afterEach, it, expect } from 'vitest';
import type { ThreadView, ThreadSummary, GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, emptyFleet, everyAttentionFleet } from './fixtures/glass-snapshots.js';
const ID = 'abcdef01-1234-4000-8000-abcdef012345';
const KEY = 'decision:0a1b2c3d';
const AT = new Date(NOW).toISOString();
const summary = (): ThreadSummary => ({ id: ID, grounds: 'home', title: 'Navigation', kind: 'thread', state: 'open', roundCount: 6, updatedAt: AT, cards: [KEY], waitingForHelm: false });
const view = (): ThreadView => ({ ...summary(), text: 'How do we navigate?', attachments: [], notes: { decided: ['Keep Reviews'], open: ['Choose the middle tab'] }, rounds: Array.from({ length: 6 }, (_, i) => ({ at: new Date(NOW + i).toISOString(), entries: [{ by: 'person', via: i === 0 ? 'chat' : 'glass', text: `Round ${i + 1}`, attachments: [] }, ...(i === 5 ? [{ card: KEY }] : [])] })), createdAt: AT, lastPersonAt: AT, cards: [{ key: KEY, title: 'Use Helm?', options: ['Yes'], standing: true }] });
const pages: GlassDom[] = [];
afterEach(async () => { for (const page of pages) await page.close(); pages.length = 0; });
function fleet() { const d = emptyFleet(); d.focusToken = 'tok'; d.threads = [summary()]; d.answerLimits = { maxBytes: 1024, maxFiles: 8, textMax: 20000, extensions: ['.png', '.txt'] }; return d; }
async function page(d: GlassSnapshot, options: Partial<GlassDomOptions> = {}) { const p = await loadGlass(GLASS_PAGE, d, { now: NOW, get: url => url === `/threads/${ID}` ? { status: 200, body: view() } : undefined, ...options, prepare: w => { Object.defineProperty(w, 'IntersectionObserver', { value: undefined, configurable: true }); options.prepare?.(w); } }); pages.push(p); return p; }
async function click(g: GlassDom, selector: string) { (g.$(selector) as HTMLElement).click(); await g.settle(); }
async function type(g: GlassDom, text: string, label = 'Your message') { const input = g.$(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement; input.value = text; input.dispatchEvent(new g.window.Event('input', { bubbles: true })); await g.settle(); }
it('opens one card composer from the message button and retains its draft after closing', async () => {
  const g = await page(fleet());
  await click(g, '.message-fab');
  expect(g.$('[role="dialog"]')?.textContent).toContain('Message the helm');
  expect(g.$$('.dcompose')).toHaveLength(1);
  expect(g.$('input[aria-label="Attach"]')).not.toBeNull();
  expect(g.$('[role="dialog"] select')).toBeNull();
  await type(g, 'Keep reviews in the bar');
  await click(g, '.dialog-close'); await click(g, '.message-fab');
  expect((g.$('textarea.danswer') as HTMLTextAreaElement).value).toBe('Keep reviews in the bar');
});
it('keeps a failed send for retry and opens its stored conversation after success', async () => {
  const d = fleet(); let tries = 0;
  const g = await page(d, { post: (_url, req) => { const body = JSON.parse(req.body); if (body.kind !== 'thread-start') return { status: 404, body: {} }; return ++tries === 1 ? { status: 503, body: { ok: false, reason: 'Try again' } } : { status: 201, body: { ok: true, item: view() } }; } });
  await click(g, '.message-fab'); await type(g, 'Where should Helm go?');
  await click(g, '.dsend'); expect(g.$('.derr')?.textContent).toBe('Try again');
  expect((g.$('textarea.danswer') as HTMLTextAreaElement).value).toBe('Where should Helm go?');
  await click(g, '.dsend');
  expect(g.window.location.hash).toBe(`#thread/${ID}`);
  expect(g.$('.dialog-scrim')).toBeNull();
  expect(g.$('.tsheet')?.textContent).toContain('Keep Reviews');
  expect(JSON.parse(g.posts().at(-1)!.body)).toMatchObject({ kind: 'thread-start', payload: { text: 'Where should Helm go?', grounds: 'home' } });
});
it('shows current notes, cards, every round, chat provenance, and the long-thread hint', async () => {
  const g = await page(fleet(), { hash: `#thread/${ID}` });
  expect(g.$('.tsheet')?.textContent).toContain('Choose the middle tab');
  expect(g.$('.tsheet')?.textContent).toContain('Card for you');
  expect(g.$('.thread-hint')?.textContent).toContain('long thread');
  // One continuous chat: every message, no round headers.
  expect(g.$$('.thread-timeline .thread-msg.from-person').map((el) => el.querySelector('.thread-text')?.textContent)).toEqual(['Round 1', 'Round 2', 'Round 3', 'Round 4', 'Round 5', 'Round 6']);
  expect(g.$('.thread-timeline section, .thread-round, .thread-round-label')).toBeNull();
  expect(g.$('.thread-timeline')?.textContent).not.toMatch(/Round \d+ ·/);
  expect(g.$('.thread-msg.from-person .thread-meta')?.textContent).toContain('You · in chat');
  expect(g.$('.dcompose')).not.toBeNull();
  await g.go('#helm'); expect(g.$('#helm [aria-label="Waiting for you"]')).not.toBeNull();
  expect(g.$('.bbitem[href="#helm"]')).not.toBeNull();
  expect(g.$('.bbitem[href="#prs"]')).toBeNull();
});
it('shows an outcome and reopens without answering the standing card', async () => {
  const d = fleet(); d.threads![0] = { ...summary(), state: 'resolved', outcome: { kind: 'answered', note: 'Helm gets the middle tab', at: AT } };
  const resolved = { ...view(), state: 'resolved', outcome: d.threads![0]!.outcome };
  const g = await page(d, { hash: `#thread/${ID}`, get: url => url.startsWith('/threads/') ? { status: 200, body: resolved } : undefined, post: () => { d.threads![0] = summary(); return { status: 200, body: { ok: true } }; } });
  expect(g.$('.thread-outcome')?.textContent).toContain('Helm gets the middle tab');
  expect(g.$('.dcompose')).toBeNull();
  const reopen = g.$$('.tsheet button').find(el => el.textContent === 'Reopen') as HTMLElement;
  reopen.click(); await g.settle();
  expect(g.posts().map(p => JSON.parse(p.body).kind)).toEqual(['thread-reopen']);
});
it('shows the thread name on a decision row and its notes above the question', async () => {
  const d = fleet(); d.decisions = [{ key: KEY, thread: ID, title: 'Use Helm?', detail: 'Which tab?', options: ['Yes'], attachments: [], askedBy: 'helm', askedAt: AT, stateHash: 's' }];
  d.attention = [{ kind: 'decision', key: KEY, id: KEY, verb: 'decision', ageSecs: 0, stateHash: 's' }];
  const g = await page(d);
  expect(g.$('.drow')?.textContent).toContain('Navigation');
  await click(g, '.drow .dopen');
  expect(g.$('.thread-notes')?.textContent).toContain('Keep Reviews');
  expect(g.$('.dbody')?.textContent?.indexOf('Keep Reviews')).toBeLessThan(g.$('.dbody')!.textContent!.indexOf('Use Helm?'));
  expect(g.$('.dcompose')).not.toBeNull();
});

it('uses the shared message sheet with dispatch context', async () => {
  const d = everyAttentionFleet(); d.focusToken = 'tok';
  const id = d.dispatches[0]!.id;
  const g = await page(d, { hash: '#dispatch/' + id, post: () => ({ status: 503, body: { ok: false, reason: 'Retry' } }) });
  const control = g.$$('button').find(el => el.textContent === 'Message the helm') as HTMLElement;
  expect(control).toBeDefined(); control.click(); await g.settle();
  expect(g.$('[role="dialog"] p.dim')?.textContent).toMatch(/^About Brief for /);
  await type(g, 'Consider this change'); await click(g, '.dsend');
  expect(JSON.parse(g.posts().at(-1)!.body)).toMatchObject({ kind: 'thread-start', payload: { about: id, text: 'Consider this change' } });
});

it('counts one unread response per thread, marks only its displayed sequence read and keeps Card for you', async () => {
  const d = fleet();
  d.threads![0] = {...summary(),responseSeq:5,seenThrough:3,unreadResponse:true,responseText:'Notes updated'};
  const response = {...view(),responseSeq:5,seenThrough:3,unreadResponse:true,responseText:'Notes updated'};
  const g = await page(d,{hash:'#helm',get:url=>url.startsWith('/threads/')?{status:200,body:response}:undefined,post:(_url,req)=>{
    const sent=JSON.parse(req.body);
    if(sent.kind==='thread-seen') { d.threads![0]={...d.threads![0]!,seenThrough:5,unreadResponse:false}; return {status:200,body:{ok:true}}; }
    return {status:404,body:{}};
  }});
  expect(g.$('.bbitem[href="#helm"] .dbadge')?.textContent).toBe('1');
  expect(g.$('#helm .page-head h1')?.textContent).toBe('Threads');
  expect(g.$('#helm .drow.unread')).not.toBeNull();
  expect(g.$$('#helm .drow')).toHaveLength(1);
  await click(g,'#helm .drow .dopen');
  expect(g.posts().map(p=>JSON.parse(p.body))).toContainEqual({kind:'thread-seen',payload:{id:ID,through:5}});
  expect(g.posts().some(p=>JSON.parse(p.body).kind==='decision-answer')).toBe(false);
  await g.go('#helm');
  expect(g.$('.bbitem[href="#helm"] .dbadge')).toBeNull();
  expect(g.$('#helm [aria-label="Waiting for you"]')).not.toBeNull();
  expect(g.$('#helm .drow.unread')).toBeNull();
  expect(g.$$('#helm .drow')).toHaveLength(1);
});
it('retains message and thread drafts when read receipts or polls replace the snapshot', async () => {
  const d=fleet(); const g=await page(d,{hash:`#thread/${ID}`});
  await type(g,'A thread draft','Add to this thread');
  d.threads![0]={...summary(),openLine:'A fresh note'}; g.serve(d); await g.poll();
  expect((g.$('textarea.danswer') as HTMLTextAreaElement).value).toBe('A thread draft');
  await g.go('#helm'); await click(g,'.message-fab'); await type(g,'A new message draft');
  d.threads![0]={...summary(),openLine:'Another note'}; g.serve(d); await g.poll();
  expect((g.$('textarea.danswer') as HTMLTextAreaElement).value).toBe('A new message draft');
});
it('leaves a response unread while its conversation is in a hidden tab', async () => {
  const d=fleet(); d.threads![0]={...summary(),responseSeq:2,seenThrough:0,unreadResponse:true};
  const response={...view(),responseSeq:2,seenThrough:0,unreadResponse:true,responseText:'Notes updated'};
  const g=await page(d,{hash:`#thread/${ID}`,hidden:true,get:url=>url.startsWith('/threads/')?{status:200,body:response}:undefined,post:()=>({status:200,body:{ok:true}})});
  expect(g.posts().some(p=>JSON.parse(p.body).kind==='thread-seen')).toBe(false);
  await g.hide(false);
  expect(g.posts().map(p=>JSON.parse(p.body))).toContainEqual({kind:'thread-seen',payload:{id:ID,through:2}});
});

it('waits until the response enters the viewport before acknowledging it', async () => {
  const d=fleet(); d.threads![0]={...summary(),responseSeq:2,seenThrough:0,unreadResponse:true};
  const response={...view(),responseSeq:2,seenThrough:0,unreadResponse:true,responseText:'Notes updated'};
  let show: (()=>void) | undefined;
  const g=await page(d,{hash:`#thread/${ID}`,get:url=>url.startsWith('/threads/')?{status:200,body:response}:undefined,post:()=>({status:200,body:{ok:true}}),prepare:w=>{
    Object.defineProperty(w,'IntersectionObserver',{configurable:true,value:class {
      constructor(callback:(entries:Array<{isIntersecting:boolean}>)=>void) { show=()=>callback([{isIntersecting:true}]); }
      observe() {} disconnect() {}
    }});
  }});
  expect(g.posts().some(p=>JSON.parse(p.body).kind==='thread-seen')).toBe(false);
  expect(show).toBeDefined(); show!(); await g.settle();
  expect(g.posts().map(p=>JSON.parse(p.body))).toContainEqual({kind:'thread-seen',payload:{id:ID,through:2}});
});

it('groups all open conversation kinds together and keeps resolved ones, read, in the collapsed section', async () => {
  const d = fleet();
  d.threads = [
    { ...summary(), id: 'open-bait', kind: 'bait', title: 'Queued work', cards: [], waitingForHelm: true },
    { ...summary(), id: 'unread-thread', unreadResponse: true, responseText: 'Please choose a target', title: 'A discussion' },
    { ...summary(), id: 'acked-thread', cards: [], title: 'Acknowledged work' },
    { ...summary(), id: 'resolved-thread', state: 'resolved', cards: [], unreadResponse: false, responseSeq: 4, seenThrough: 2, title: 'Finished work' },
  ];
  const g = await page(d, { hash: '#helm' });
  expect(g.$$('#helm > section > .dlist .drow').map((row) => row.getAttribute('data-thread')).sort()).toEqual(['acked-thread', 'open-bait', 'unread-thread']);
  expect(g.$('#helm .thread-resolved')?.hasAttribute('open')).toBe(false);
  expect(g.$('#helm .thread-resolved > summary')?.textContent).toBe('Resolved (1)');
  expect(g.$('#helm .thread-resolved [data-thread="resolved-thread"].read')).not.toBeNull();
  expect(g.$('#helm .thread-resolved [aria-label="Resolved"]')).not.toBeNull();
  expect(g.$('.bbitem[href="#helm"] .dbadge')?.textContent).toBe('1');
  expect(g.$('#helm [data-thread="unread-thread"].unread')).not.toBeNull();
  expect(g.$('#helm [data-thread="acked-thread"].unread')).toBeNull();
  expect(g.$('#helm [aria-label="Waiting for helm"]')).not.toBeNull();
  expect(g.$('#helm [aria-label="Waiting for you"]')).not.toBeNull();
  expect(g.$('#helm [aria-label="Acknowledged"]')).not.toBeNull();
  expect(g.$('#helm [data-thread="unread-thread"] .dpreview')?.textContent).toBe('Please choose a target');
  expect(g.$('#helm')?.textContent).not.toContain('Bait');
  expect(g.posts().some((p) => JSON.parse(p.body).kind === 'thread-seen')).toBe(false);
});

it('shows the notes box and existing dispatch, report and PR cards in conversation rounds', async () => {
  const d = everyAttentionFleet(); d.focusToken = 'tok'; d.threads = [summary()];
  const dispatch = d.dispatches[0]!, report = d.reports[0]!, pr = d.prs[0]!; dispatch.title = 'Implement the navigation change';
  const detail = view();
  detail.rounds = [{ at: AT, entries: [
    { link: 'dispatched', ref: dispatch.id, text: 'Dispatch link' },
    { link: 'report', ref: report.key, text: 'Report link' },
    { link: 'planned', ref: pr.url, text: 'PR link' },
  ] }];
  const g = await page(d, { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined });
  expect(g.$$('.thread-notes-box li').map((li) => [li.className, li.querySelector('.thread-note-mark')?.textContent, li.textContent])).toEqual([
    ['decided', '✓', '✓Decided: Keep Reviews'],
    ['open', '?', '?Open: Choose the middle tab'],
  ]);
  expect(g.$$('.thread-links .card')).toHaveLength(3);
  expect(g.$('.thread-links')?.textContent).toContain(dispatch.title);
  expect(g.$('.tsheet')?.textContent).toContain(report.title);
  expect(g.$('.tsheet')?.textContent).toContain(pr.title);
});

it('opens a conversation in a sheet over the Threads list and returns to the list on Back', async () => {
  const g = await page(fleet(), { hash: '#helm' });
  await click(g, `#helm [data-thread="${ID}"] .dopen`);
  expect(g.window.location.hash).toBe(`#thread/${ID}`);
  expect(g.$('.tsheet[role="dialog"] .rbartitle')?.textContent).toBe('Navigation');
  expect(g.$('.tsheet')?.textContent).toContain('Choose the middle tab');
  expect(g.$(`#helm [data-thread="${ID}"]`)).not.toBeNull();
  expect(g.$('#helm .thread-view')).toBeNull();
  expect(g.$('.message-fab')).toBeNull();
  await click(g, '.tsheet .rback');
  expect(g.window.location.hash).toBe('#helm');
  expect(g.$('.tsheet')).toBeNull();
  expect(g.$(`#helm [data-thread="${ID}"]`)).not.toBeNull();
  expect(g.$('.message-fab')).not.toBeNull();
});
it('closes a linked conversation to the Threads list without leaving the glass', async () => {
  const g = await page(fleet(), { hash: `#thread/${ID}` });
  expect(g.$('.tsheet')).not.toBeNull();
  await click(g, '.tsheet .rback');
  expect(g.window.location.hash).toBe('#helm');
  expect(g.$('.tsheet')).toBeNull();
  expect(g.$('#helm .page-head h1')?.textContent).toBe('Threads');
});

it('reads as a chat: the person on the right, the helm beside its wheel, system lines between, in order', async () => {
  const detail = view();
  detail.notesAt = new Date(NOW - 4 * 60_000).toISOString();
  detail.responseSeq = 3; detail.seenThrough = 2; detail.unreadResponse = true;
  detail.rounds = [
    { at: AT, entries: [
      { by: 'person', via: 'glass', text: 'Reviews barely gets used on the phone', attachments: [], at: AT },
      { event: 'triaged', kind: 'thread', at: AT },
      { by: 'helm', text: 'Is that true on desktop too?', attachments: [], at: AT, seq: 2 },
    ] },
    { at: AT, entries: [
      { by: 'person', via: 'glass', text: 'Only on the phone', attachments: [], at: AT },
      { by: 'helm', text: 'I will keep the question open for you', attachments: [{ name: 'sketch.png', path: '/x/sketch.png', bytes: 12, type: 'image/png' }], at: AT, seq: 3 },
      { card: KEY },
    ] },
  ];
  const g = await page(fleet(), { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined });
  const order = g.$$('.thread-timeline .thread-entry').map((el) => el.classList.contains('from-person') ? 'person' : el.classList.contains('from-helm') ? 'helm' : el.classList.contains('thread-card-entry') ? 'card' : 'system');
  expect(order).toEqual(['person', 'system', 'helm', 'person', 'helm', 'card']);
  expect(g.$('.thread-system')?.textContent).toContain('Discussion started');
  expect(g.$$('.from-helm .thread-avatar svg')).toHaveLength(2);
  expect(g.$$('.from-helm.unread').map((el) => el.textContent)).toEqual([expect.stringContaining('I will keep the question open for you')]);
  expect(g.$('.from-helm.unread .thread-meta')?.textContent).toContain('New');
  expect(g.$('.from-helm.unread img, .from-helm.unread a[download]')).not.toBeNull();
  expect(g.$('.thread-notes-head')?.textContent).toBe('Notes · helm · updated 4m ago');
  expect(g.$('textarea[aria-label="Add to this thread"]')).not.toBeNull();
  const notes = g.$('.thread-notes-box')!, timeline = g.$('.thread-timeline')!, composer = g.$('.thread-view .dcompose')!;
  expect(notes.compareDocumentPosition(timeline) & g.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(timeline.compareDocumentPosition(composer) & g.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('opens Message the helm on a dispatch page with the cursor in the message, over the dispatch', async () => {
  const d = everyAttentionFleet(); d.focusToken = 'tok'; d.threads = [];
  const id = d.dispatches[0]!.id;
  const g = await page(d, { hash: '#dispatch/' + id });
  (g.$$('button').find((el) => el.textContent === 'Message the helm') as HTMLElement).click();
  await g.settle(); await new Promise((r) => setTimeout(r, 5)); await g.settle();
  expect(g.$('.dialog-scrim .message-dialog')).not.toBeNull();
  expect(g.window.document.activeElement).toBe(g.$('.message-dialog textarea[aria-label="Your message"]'));
  expect(g.window.location.hash).toBe('#dispatch/' + id);
});

it("opens the dispatch's unresolved thread instead of a new message, ready to type in", async () => {
  const d = everyAttentionFleet(); d.focusToken = 'tok';
  const id = d.dispatches[0]!.id;
  d.threads = [{ ...summary(), about: id, title: d.dispatches[0]!.title, cards: [] }];
  const g = await page(d, { hash: '#dispatch/' + id });
  (g.$$('button').find((el) => el.textContent === 'Message the helm') as HTMLElement).click();
  await g.settle(); await new Promise((r) => setTimeout(r, 5)); await g.settle();
  expect(g.window.location.hash).toBe(`#thread/${ID}`);
  expect(g.$('.message-dialog')).toBeNull();
  expect(g.window.document.activeElement).toBe(g.$('.tsheet textarea[aria-label="Add to this thread"]'));
});

it('heads a thread about a dispatch with its card: title, repo, trap, state, last note, PRs and a link', async () => {
  const d = everyAttentionFleet(); d.focusToken = 'tok';
  const dispatch = d.dispatches[0]!, pr = d.prs[0]!;
  dispatch.title = 'Deflake the deck test'; dispatch.note = 'Reproduced the race\nsecond line'; dispatch.repo = 'web'; dispatch.for = 'wt:tiny-seal';
  dispatch.prList = [{ url: pr.url, number: pr.number }];
  d.threads = [{ ...summary(), about: dispatch.id, title: 'Deflake the deck test' }];
  const detail = { ...view(), about: dispatch.id, title: 'Deflake the deck test' };
  const g = await page(d, { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined });
  const card = g.$('.thread-view .thread-about .thread-dispatch')!;
  expect(card).not.toBeNull();
  expect(card.compareDocumentPosition(g.$('.thread-timeline')!) & g.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card.querySelector('.gtitle')?.textContent).toBe('Deflake the deck test');
  expect(card.querySelector('.gcontext')?.textContent).toContain('web');
  expect(card.querySelector('.gcontext')?.textContent).toContain('tiny-seal');
  expect(card.querySelector('.gtop')?.textContent).not.toBe('');
  expect(card.querySelector('.gnow')?.textContent).toBe('Reproduced the race');
  expect(card.querySelector(`a[href="${pr.url}"]`)?.textContent).toBe(`PR #${pr.number}`);
  expect(card.querySelector(`a[href="#dispatch/${dispatch.id}"]`)?.textContent).toBe('Open dispatch');
  expect(g.$('.tsheet .rbartitle')?.textContent).toBe('Deflake the deck test');
});

it('keeps tracking threads out of the open list, in a collapsed Tracking section', async () => {
  const d = fleet();
  d.threads = [
    { ...summary(), id: 'open-thread', title: 'Still talking', cards: [] },
    { ...summary(), id: 'tracking-thread', state: 'tracking', title: 'Fix is running', cards: [], outcome: { kind: 'dispatched', ref: 'd1', note: 'Dispatched', at: AT } },
    { ...summary(), id: 'resolved-thread', state: 'resolved', title: 'Done', cards: [] },
  ];
  const g = await page(d, { hash: '#helm' });
  expect(g.$$('#helm > section > .dlist .drow').map((row) => row.getAttribute('data-thread'))).toEqual(['open-thread']);
  const tracking = g.$('#helm .thread-tracking')!;
  expect(tracking.hasAttribute('open')).toBe(false);
  expect(tracking.querySelector('summary')?.textContent).toBe('Tracking (1)');
  expect(tracking.querySelector('[data-thread="tracking-thread"] [aria-label="Tracking"]')).not.toBeNull();
  expect(g.$('#helm .thread-resolved:not(.thread-tracking) [data-thread="resolved-thread"]')).not.toBeNull();
});

it('shows linked work with its live state, read-only, and keeps the composer on a tracking thread', async () => {
  const detail = { ...view(), state: 'tracking' as const, outcome: { kind: 'dispatched' as const, ref: 'd1', note: 'Dispatched the fix', at: AT } };
  detail.tracked = [
    { kind: 'dispatch', ref: 'd1', title: 'Fix the flaky deck test', state: 'open', status: 'working', href: '#dispatch/d1' },
    { kind: 'pr', ref: 'pr:o/r#7', title: 'Deflake the deck test', state: 'stalled', status: 'checks failing', href: 'https://github.com/o/r/pull/7' },
    { kind: 'todo', ref: '3', title: 'Check it tomorrow', state: 'done', status: 'done' },
  ];
  detail.rounds = [{ at: AT, entries: [{ by: 'person', via: 'glass', text: 'Fix it', attachments: [], at: AT }, { event: 'tracked', text: 'All linked work finished', at: AT }] }];
  const g = await page(fleet(), { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined });
  const panel = g.$('.thread-tracked')!;
  expect(panel.querySelector('.thread-notes-head')?.textContent).toBe('Tracking · closes when this work finishes');
  expect(g.$$('.thread-tracked li').map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
    'Dispatch Fix the flaky deck test working',
    'PR Deflake the deck test checks failing',
    'Todo Check it tomorrow done',
  ]);
  expect(g.$$('.thread-tracked .badge').map((b) => b.className)).toEqual(['badge ', 'badge warn', 'badge ok']);
  expect(panel.querySelector('a[href="#dispatch/d1"]')).not.toBeNull();
  expect(panel.querySelector('button, input, textarea')).toBeNull();
  expect(g.$('.thread-system')?.textContent).toContain('All linked work finished');
  expect(g.$('textarea[aria-label="Add to this thread"]')).not.toBeNull();
});

it('marks each linked item with the icon its kind has in the glass views', async () => {
  const d = everyAttentionFleet(); d.focusToken = 'tok'; d.threads = [summary()];
  const dispatch = d.dispatches[0]!, report = d.reports[0]!, pr = d.prs[0]!;
  const gone = 'aaaa0000-0000-4000-8000-00000000dead';
  const detail = view();
  detail.rounds = [{ at: AT, entries: [
    { link: 'dispatched', ref: dispatch.id, text: 'Dispatch link' },
    { link: 'dispatched', ref: gone, text: 'Missing dispatch' },
    { link: 'report', ref: report.key, text: 'Report link' },
    { link: 'planned', ref: pr.url, text: 'PR link' },
    { link: 'planned', ref: 'https://app.ume.so/a/plan', text: 'The plan' },
    { card: KEY },
  ] }];
  const g = await page(d, { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : url === `/data/dispatch/${gone}` ? { status: 404, body: {} } : undefined });
  const icons = g.$$('.thread-timeline .thread-work-icon');
  const svg = (el: Element | null | undefined) => el?.querySelector('svg')?.outerHTML;
  const tab = (name: string) => g.$$(`a[href="#${name}"]`).map(svg).find(Boolean);
  expect(icons.map((el) => el.getAttribute('title'))).toEqual(['Dispatch', 'Dispatch', 'Report', 'PR', 'Plan', 'Card']);
  expect(icons.map((el) => el.querySelector('.sr-only')?.textContent)).toEqual(['Dispatch: ', 'Dispatch: ', 'Report: ', 'PR: ', 'Plan: ', 'Card: ']);
  expect(svg(icons[0])).toBe(tab('dispatches'));
  expect(svg(icons[1])).toBe(tab('dispatches'));
  expect(svg(icons[2])).toBe(tab('reports'));
  expect(svg(icons[3])).toBe(tab('prs'));
  expect(svg(icons[5])).toBe(tab('deck'));
  expect(new Set(icons.map(svg)).size).toBe(5);
  expect(g.$$('.thread-work-dispatch .card')).toHaveLength(1);
  expect(g.$(`.thread-work-dispatch a[href="#dispatch/${gone}"]`)?.textContent).toBe('Missing dispatch');
  expect(g.$('.thread-work-plan a')?.getAttribute('href')).toBe('https://app.ume.so/a/plan');
});

/**
 * happy-dom has no layout: the sheet's scroller is 300px tall, holds 100px
 * per entry, and clamps scrollTop as a browser does.
 */
function layout(w: unknown) {
  const win = w as Window & typeof globalThis;
  const tops = new WeakMap<Element, number>();
  const sheet = (el: Element) => el.classList.contains('rbody');
  const height = (el: Element) => (sheet(el) ? el.querySelectorAll('.thread-entry').length * 100 + 400 : 0);
  const proto = win.HTMLElement.prototype;
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get(this: Element) { return height(this); } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get(this: Element) { return sheet(this) ? 300 : 0; } });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: Element) { return Math.min(tops.get(this) ?? 0, Math.max(0, height(this) - 300)); },
    set(this: Element, y: number) { tops.set(this, Math.max(0, Math.min(y, height(this) - 300))); },
  });
}
const scroller = (g: GlassDom) => g.$('.tsheet .rbody') as HTMLElement;
const bottom = (g: GlassDom) => scroller(g).scrollHeight - scroller(g).clientHeight;
async function scrollTo(g: GlassDom, y: number) { scroller(g).scrollTop = y; scroller(g).dispatchEvent(new g.window.Event('scroll')); await g.settle(); }

it('opens a conversation already at its newest message, with no stop at the top first', async () => {
  const shown: number[][] = [];
  const g = await page(fleet(), { hash: '#helm', prepare: (w) => {
    layout(w);
    // Where the sheet stands at each change while the conversation is in the page: before the browser could paint it.
    new w.MutationObserver(() => {
      const box = w.document.querySelector('.tsheet .rbody') as HTMLElement | null;
      if (box?.querySelector('.thread-timeline')) shown.push([box.scrollTop, box.scrollHeight - box.clientHeight]);
    }).observe(w.document, { childList: true, subtree: true, characterData: true });
  } });
  await click(g, `#helm [data-thread="${ID}"] .dopen`);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown[0]![0]).toBeGreaterThan(0);
  for (const [at, end] of shown) expect(at).toBe(end);
  expect(scroller(g).scrollTop).toBe(bottom(g));
});

it('stays at the newest message as messages arrive, and leaves a reader who scrolled up where they are', async () => {
  const d = fleet(); let detail = view();
  const g = await page(d, { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined, prepare: layout });
  const grow = async (text: string) => {
    detail = { ...detail, updatedAt: new Date(Date.parse(detail.updatedAt) + 1000).toISOString(), rounds: [...detail.rounds, { at: AT, entries: [{ by: 'person', via: 'glass', text, attachments: [] }] }] };
    d.threads![0] = { ...summary(), updatedAt: detail.updatedAt }; g.serve(d); await g.poll(); await g.settle();
  };
  const timeline = g.$('.thread-timeline'), first = bottom(g);
  expect(scroller(g).scrollTop).toBe(first);
  await grow('One more');
  expect(g.$('.tsheet')?.textContent).toContain('One more');
  expect(bottom(g)).toBeGreaterThan(first);
  expect(scroller(g).scrollTop).toBe(bottom(g));
  // A refresh keeps the conversation on the page rather than swapping in the loading line.
  expect(g.$('.thread-timeline')).toBe(timeline);
  await scrollTo(g, 100);
  await grow('And another');
  expect(g.$('.tsheet')?.textContent).toContain('And another');
  expect(scroller(g).scrollTop).toBe(100);
});

it('opens the next conversation at its newest message after reading back through another', async () => {
  const d = fleet(), other = 'abcdef02-1234-4000-8000-abcdef012345';
  d.threads = [summary(), { ...summary(), id: other, title: 'Another' }];
  const g = await page(d, { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: { ...view(), id: decodeURIComponent(url.slice('/threads/'.length)), title: url.includes(other) ? 'Another' : 'Navigation' } } : undefined, prepare: layout });
  await scrollTo(g, 0);
  await g.go(`#thread/${other}`);
  expect(g.$('.tsheet .rbartitle')?.textContent).toBe('Another');
  expect(scroller(g).scrollTop).toBeGreaterThan(0);
  expect(scroller(g).scrollTop).toBe(bottom(g));
});

