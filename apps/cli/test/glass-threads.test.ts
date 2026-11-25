import { afterEach, it, expect } from 'vitest';
import type { ThreadView, ThreadSummary, GlassSnapshot } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
import { NOW, acceptanceFleet, emptyFleet, everyAttentionFleet } from './fixtures/glass-snapshots.js';
const ID = 'abcdef01-1234-4000-8000-abcdef012345';
const KEY = 'decision:0a1b2c3d';
const AT = new Date(NOW).toISOString();
const summary = (): ThreadSummary => ({ id: ID, grounds: 'home', title: 'Navigation', kind: 'thread', state: 'open', roundCount: 6, updatedAt: AT, cards: [KEY], waitingForHelm: false });
const view = (): ThreadView => ({ ...summary(), text: 'How do we navigate?', attachments: [], notes: { decided: ['Keep Reviews'], open: ['Choose the middle tab'] }, rounds: Array.from({ length: 6 }, (_, i) => ({ at: new Date(NOW + i).toISOString(), entries: [{ by: 'person', via: i === 0 ? 'chat' : 'glass', text: `Round ${i + 1}`, attachments: [] }, ...(i === 5 ? [{ card: KEY }] : [])] })), createdAt: AT, lastPersonAt: AT, cards: [{ key: KEY, title: 'Use Helm?', options: ['Yes'], standing: true }] });
const pages: GlassDom[] = [];
afterEach(async () => { for (const page of pages) await page.close(); pages.length = 0; });
function fleet() { const d = emptyFleet(); d.focusToken = 'tok'; d.threads = [summary()]; d.answerLimits = { maxBytes: 1024, maxFiles: 8, textMax: 20000, extensions: ['.png', '.txt'] }; return d; }
async function page(d: GlassSnapshot, options: Partial<GlassDomOptions> = {}) { const p = await loadGlass(GLASS_PAGE, d, { now: NOW, get: url => url === `/threads/${ID}` ? { status: 200, body: view() } : url.startsWith('/threads/') ? { status: 404, body: { error: 'not found' } } : undefined, ...options, prepare: w => { Object.defineProperty(w, 'IntersectionObserver', { value: undefined, configurable: true }); options.prepare?.(w); } }); pages.push(p); return p; }
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
it('shows a sent message at once; a failed one returns to its draft through a toast, and is written once when sent again', async () => {
  const d = fleet(); let tries = 0; let started = ''; let delivered = false;
  let fail: () => void = () => {};
  const words = 'Where should Helm go?';
  const stored = (): ThreadView => ({ ...view(), id: started, title: words, rounds: [{ at: AT, entries: [{ by: 'person', via: 'glass', text: words, attachments: [], at: AT, submission: started }] }] });
  const g = await page(d, {
    get: (url) => url.startsWith('/api/submissions/') ? { status: 200, body: { ok: true, state: 'applied' } }
      // The conversation exists once the message is delivered.
      : url === `/threads/${encodeURIComponent(started)}` ? (delivered ? { status: 200, body: stored() } : { status: 404, body: { error: 'not found' } }) : undefined,
    post: (_url, req) => {
      const body = JSON.parse(req.body);
      if (body.kind !== 'thread-start') return { status: 404, body: {} };
      started = body.payload.submission;
      if (++tries === 1) return new Promise((done) => (fail = () => done({ status: 503, body: { ok: false, reason: 'Try again' } })));
      // Recorded: the snapshot after delivery lists the new conversation.
      delivered = true;
      d.threads = [...(d.threads ?? []), { ...summary(), id: started, title: words, updatedAt: new Date(NOW + 1000).toISOString() }];
      return { status: 202, body: { ok: true, state: 'pending', submission: started } };
    },
  });
  await click(g, '.message-fab'); await type(g, words);
  await click(g, '.dsend');
  // The conversation opens under the page's own id, with the message in it; the dialog is gone.
  expect(g.window.location.hash).toBe(`#thread/${started}`);
  expect(g.$('.dialog-scrim')).toBeNull();
  expect(g.$('.tsheet .pending-msg .thread-meta')?.textContent).toBe('You · Sending');
  expect(g.$('.tsheet .pending-msg .thread-text')?.textContent).toBe(words);
  // The send fails: the never-written conversation closes, and a toast says what didn't go through.
  fail(); await g.settle();
  expect(g.$('.tsheet')).toBeNull();
  expect(g.$('.dretry')).toBeNull();
  const toast = g.$('.toast-action .toast-open')!;
  expect(toast.textContent).toBe("Your message to the helm didn't go through. Open it to try again.");
  // It opens the message dialog with the draft and the reason.
  await click(g, '.toast-action .toast-open');
  expect((g.$('textarea[aria-label="Your message"]') as HTMLTextAreaElement).value).toBe(words);
  expect(g.$('[role="dialog"] .derr')?.textContent).toBe('Try again');
  await click(g, '[role="dialog"] .dsend');
  // Sent again under the same id, so it can be recorded only once.
  const sent = g.posts().filter((p) => JSON.parse(p.body).kind === 'thread-start').map((p) => JSON.parse(p.body).payload);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ text: words, grounds: 'home', submission: sent[0].submission });
  expect(g.$('.pending-msg')).toBeNull();
  expect(g.$$('.tsheet .thread-msg.from-person .thread-text').map((el) => el.textContent)).toEqual([words]);
});
it('a reply that fails goes back to its conversation’s composer, and the toast opens that conversation', async () => {
  const g = await page(fleet(), { hash: '#helm', post: (_url, req) => (JSON.parse(req.body).kind === 'thread-post' ? { status: 409, body: { ok: false, state: 'failed', reason: 'Reopen this conversation before adding to it' } } : { status: 200, body: { ok: true } }) });
  await g.go(`#thread/${ID}`);
  await type(g, 'Keep the old tab too', 'Add to this thread');
  await click(g, '.tsheet .dsend');
  expect(g.$('.pending-msg')).toBeNull();
  expect(g.$('.toast-action .toast-open')?.textContent).toBe("Your message in “Navigation” didn't go through. Open it to try again.");
  await g.go('#helm');
  expect(g.$('.tsheet')).toBeNull();
  await click(g, '.toast-action .toast-open');
  expect(g.window.location.hash).toBe(`#thread/${ID}`);
  expect((g.$('.tsheet textarea[aria-label="Add to this thread"]') as HTMLTextAreaElement).value).toBe('Keep the old tab too');
  expect(g.$('.tsheet .derr')?.textContent).toBe('Reopen this conversation before adding to it');
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

it("heads a card with its thread: the helm's last message under its wheel and the notes, without the work box", async () => {
  const d = fleet(); d.decisions = [{ key: KEY, thread: ID, title: 'Use Helm?', detail: 'Which tab?', options: ['Yes'], attachments: [], askedBy: 'helm', askedAt: AT, stateHash: 's' }];
  d.attention = [{ kind: 'decision', key: KEY, id: KEY, verb: 'decision', ageSecs: 0, stateHash: 's' }];
  const detail: ThreadView = { ...view(), responseText: 'Pick the middle tab', responseAt: AT, tracked: [{ kind: 'dispatch', ref: 'd1', title: 'Fix the deck', state: 'open', status: 'working', href: '#dispatch/d1' }] };
  const g = await page(d, { get: (url) => (url === `/threads/${ID}` ? { status: 200, body: detail } : undefined) });
  await click(g, '.drow .dopen');
  const notes = g.$('.dbody .thread-notes')!;
  expect(notes.querySelector('.thread-notes-title > .thread-avatar.helm svg')).not.toBeNull();
  expect(notes.querySelector('.thread-notes-title a')?.getAttribute('href')).toBe(`#thread/${ID}`);
  const message = notes.querySelector('.thread-response .thread-msg.from-helm .thread-bubble')!;
  expect(message.querySelector('.thread-meta > .thread-avatar.helm')).not.toBeNull();
  expect(message.querySelector('.thread-text')?.textContent).toBe('Pick the middle tab');
  expect(notes.querySelector('.thread-notes-box')?.textContent).toContain('Keep Reviews');
  expect(notes.querySelector('.thread-tracked')).toBeNull();
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

it('shows the notes box, linked dispatches and PRs as compact work cards, and a report as its own card', async () => {
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
  // Each sits between the messages at the conversation's width: title, details, and its state in words.
  const work = g.$$('.thread-timeline .thread-linked .thread-work:not(.thread-work-embed)');
  expect(work.map((el) => [el.querySelector('.thread-work-title')?.textContent, el.querySelector('.thread-work-title')?.getAttribute('href')])).toEqual([
    [dispatch.title, `#dispatch/${dispatch.id}`],
    [pr.title, `#pr/${encodeURIComponent(pr.key)}`],
  ]);
  expect(work.map((el) => el.querySelector('.thread-work-meta')?.textContent?.split(' · ')[0])).toEqual(['Dispatch', 'PR']);
  expect(work.map((el) => el.querySelector('.workpill')?.textContent)).toEqual([expect.any(String), expect.any(String)]);
  expect(g.$$('.thread-links .card')).toHaveLength(1);
  expect(g.$('.tsheet')?.textContent).toContain(report.title);
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

it('reads as a chat: the person on the right, the helm under its wheel, system lines between, in order', async () => {
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
  // Each author's round icon heads their bubble: the helm's wheel, the person's own.
  expect(g.$$('.from-helm .thread-bubble > .thread-meta > .thread-avatar.helm svg')).toHaveLength(2);
  expect(g.$$('.from-person .thread-bubble > .thread-meta > .thread-avatar.person svg')).toHaveLength(2);
  expect(g.$$('.from-helm.unread').map((el) => el.textContent)).toEqual([expect.stringContaining('I will keep the question open for you')]);
  expect(g.$('.from-helm.unread .thread-meta')?.textContent).toContain('New');
  expect(g.$('.from-helm.unread img, .from-helm.unread a[download]')).not.toBeNull();
  expect(g.$('.thread-notes-head')?.textContent).toBe('Notes · helm · updated 4m ago');
  expect(g.$('textarea[aria-label="Add to this thread"]')).not.toBeNull();
  const notes = g.$('.thread-notes-box')!, timeline = g.$('.thread-timeline')!, composer = g.$('.thread-view .dcompose')!;
  expect(notes.compareDocumentPosition(timeline) & g.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(timeline.compareDocumentPosition(composer) & g.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('shows messages as Markdown: bold, lists, code and links, raw HTML as text, line breaks as typed', async () => {
  const detail = view();
  const helm = [
    '**The Slack card gap:** the wharf reads its own store.',
    '- It is for a *shared* grounds',
    '- Run `lobstah wharf push` first',
    '',
    '```',
    'lobstah wharf push --cards',
    '```',
    'See [the docs](https://lobstah.dev/docs) or [this](javascript:alert(1)).',
    '<script>alert(2)</script><img src=x onerror="alert(3)">',
  ].join('\n');
  detail.rounds = [{ at: AT, entries: [
    { by: 'person', via: 'glass', text: 'First line\nsecond line', attachments: [], at: AT },
    { by: 'helm', text: helm, attachments: [], at: AT, seq: 1 },
  ] }];
  const g = await page(fleet(), { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined });
  const message = g.$('.from-helm .thread-text')!;
  expect(message.querySelector('strong')?.textContent).toBe('The Slack card gap:');
  expect([...message.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['It is for a shared grounds', 'Run lobstah wharf push first']);
  expect(message.querySelector('li em')?.textContent).toBe('shared');
  expect(message.querySelector('li code')?.textContent).toBe('lobstah wharf push');
  expect(message.querySelector('pre code')?.textContent).toBe('lobstah wharf push --cards');
  expect([...message.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent, a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
    ['https://lobstah.dev/docs', 'the docs', '_blank', 'noopener noreferrer'],
  ]);
  expect(message.textContent).toContain('or this.');
  // Raw HTML is shown as text: nothing it names becomes an element.
  expect(message.querySelector('script, img')).toBeNull();
  expect(message.textContent).toContain('<script>alert(2)</script><img src=x onerror="alert(3)">');
  // A single newline in a message is a line break, as the person typed it.
  const person = g.$('.from-person .thread-text p')!;
  expect(person.querySelector('br')).not.toBeNull();
  expect(person.textContent).toBe('First linesecond line');
});

it('opens a bare PR link in a message in the glass, as other notes do', async () => {
  const d = fleet();
  d.prs = acceptanceFleet().prs;
  const PR = d.prs!.find((pr) => pr.key === 'pr:acme/web#43')!.url;
  const detail = view();
  detail.rounds = [{ at: AT, entries: [{ by: 'helm', text: `Review ${PR} next`, attachments: [], at: AT, seq: 1 }] }];
  const g = await page(d, { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined });
  expect(g.$('.from-helm .thread-text a')?.getAttribute('href')).toBe('#pr/pr%3Aacme%2Fweb%2343');
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
  expect(panel.tagName).toBe('DETAILS');
  expect(panel.hasAttribute('open')).toBe(true);
  // The summary counts the work by state; the stuck PR sorts ahead of the running dispatch.
  expect(panel.querySelector('summary .thread-notes-head')?.textContent).toBe('Tracking · closes when this work finishes');
  expect([...panel.querySelectorAll('summary .workpill')].map((el) => el.textContent)).toEqual(['1 stuck', '1 in progress', '1 done']);
  expect(g.$$('.thread-tracked li').map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
    'PR: Deflake the deck test',
    'Dispatch: Fix the flaky deck test',
    'Todo: Check it tomorrow',
  ]);
  // Each kind wears the icon its view has in the glass, not a word.
  const tab = (name: string) => g.$$(`a[href="#${name}"]`).map((a) => a.querySelector('svg')?.outerHTML).find(Boolean);
  expect(g.$$('.thread-tracked li .thread-work-icon').map((el) => [el.getAttribute('title'), el.querySelector('svg')?.outerHTML])).toEqual([
    ['PR', tab('prs')],
    ['Dispatch', tab('dispatches')],
    ['Todo', tab('todos')],
  ]);
  // Each state is an icon at the right of its chip, named with its status words.
  expect(g.$$('.thread-tracked .badge')).toEqual([]);
  expect(g.$$('.thread-tracked li > :last-child').map((el) => [el.className, el.getAttribute('role'), el.getAttribute('aria-label')])).toEqual([
    ['runicon verbicon workstate work-failed bad', 'img', 'Checks failing'],
    ['runicon verbicon workstate work-working warn', 'img', 'Working'],
    ['runicon verbicon workstate work-done ok', 'img', 'Done'],
  ]);
  expect(panel.querySelector('a[href="#dispatch/d1"]')).not.toBeNull();
  expect(panel.querySelector('button, input, textarea')).toBeNull();
  expect(g.$('.thread-system')?.textContent).toContain('All linked work finished');
  expect(g.$('textarea[aria-label="Add to this thread"]')).not.toBeNull();
});

it('gives failed, done, working, paused, merged and open linked work distinct state icons', async () => {
  const detail = { ...view(), state: 'tracking' as const };
  detail.tracked = [
    { kind: 'dispatch', ref: 'd1', title: 'One', state: 'stalled', status: 'failed' },
    { kind: 'dispatch', ref: 'd2', title: 'Two', state: 'done', status: 'done' },
    { kind: 'dispatch', ref: 'd3', title: 'Three', state: 'open', status: 'working' },
    { kind: 'dispatch', ref: 'd4', title: 'Four', state: 'open', status: 'paused' },
    { kind: 'pr', ref: 'pr:o/r#1', title: 'Five', state: 'done', status: 'merged' },
    { kind: 'pr', ref: 'pr:o/r#2', title: 'Six', state: 'open', status: 'open' },
  ];
  const g = await page(fleet(), { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined });
  const icons = g.$$('.thread-tracked li > .workstate');
  expect(icons.map((el) => el.getAttribute('aria-label'))).toEqual(['Failed', 'Working', 'Paused', 'Open', 'Done', 'Merged']);
  expect(new Set(icons.map((el) => el.querySelector('svg')?.innerHTML)).size).toBe(6);
});

it('puts what needs you first in the work box, and shows a removed record by its kind, never its id', async () => {
  const gone = 'aaaa0000-0000-4000-8000-00000000dead';
  const detail = view();
  detail.tracked = [
    { kind: 'dispatch', ref: 'd1', title: 'Fix the deck', state: 'done', status: 'done', href: '#dispatch/d1' },
    { kind: 'dispatch', ref: gone, title: gone, state: 'done', status: 'gone', href: `#dispatch/${gone}` },
    { kind: 'card', ref: 'decision:ea1e6263', title: 'decision:ea1e6263', state: 'done', status: 'withdrawn' },
    { kind: 'card', ref: KEY, title: 'Use Helm?', state: 'open', status: 'waiting for you', href: `#decision/${KEY}` },
    { kind: 'dispatch', ref: 'd2', title: 'Backfill the answers', state: 'stalled', status: 'needs-decision', href: '#dispatch/d2' },
  ];
  detail.rounds = [{ at: AT, entries: [{ by: 'helm', text: 'Sent a trap', attachments: [], at: AT, seq: 1 }, { link: 'dispatched', ref: gone, text: gone, at: AT }] }];
  const g = await page(fleet(), { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : url === `/data/dispatch/${gone}` ? { status: 404, body: {} } : undefined });
  const panel = g.$('.thread-tracked')!;
  expect(panel.querySelector('summary .thread-notes-head')?.textContent).toBe('Work');
  expect([...panel.querySelectorAll('summary .workpill')].map((el) => el.textContent)).toEqual(['2 need you', '1 done', '2 removed']);
  expect(g.$$('.thread-tracked li').map((li) => [li.className || '', li.querySelector(':scope > :nth-child(2)')?.textContent, li.querySelector(':scope > a') !== null])).toEqual([
    ['', 'Use Helm?', true],
    ['', 'Backfill the answers', true],
    ['', 'Fix the deck', true],
    ['removed', 'Removed dispatch', false],
    ['removed', 'Removed card', false],
  ]);
  expect(g.$$('.thread-tracked li.removed > .workstate').map((el) => el.getAttribute('aria-label'))).toEqual(['Removed', 'Removed']);
  // In the conversation, the removed dispatch's card keeps its kind and says Removed, with nothing to open.
  const card = g.$('.thread-timeline .thread-work-dispatch')!;
  expect(card.classList.contains('removed')).toBe(true);
  expect(card.querySelector('.thread-work-title')?.textContent).toBe('Removed dispatch');
  expect(card.querySelector('a')).toBeNull();
  expect(card.querySelector('.workpill')?.textContent).toBe('Removed');
  expect(g.$('.thread-view')?.textContent).not.toContain(gone);
  expect(g.$('.thread-view')?.textContent).not.toContain('decision:ea1e6263');
});

it('marks a PR link with the PR icon and a linked card with the card icon, even when the snapshot lists neither', async () => {
  const detail = { ...view(), state: 'tracking' as const };
  detail.tracked = [{ kind: 'card', ref: KEY, title: 'Use Helm?', state: 'open', status: 'waiting for you', href: `#decision/${KEY}` }];
  detail.rounds = [{ at: AT, entries: [{ link: 'pr', ref: 'pr:o/r#7', text: 'The fix', at: AT }] }];
  const g = await page(fleet(), { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined });
  const tab = (name: string) => g.$$(`a[href="#${name}"]`).map((a) => a.querySelector('svg')?.outerHTML).find(Boolean);
  const link = g.$('.thread-timeline .thread-work-pr')!;
  expect(link.querySelector('.thread-work-icon svg')?.outerHTML).toBe(tab('prs'));
  expect(link.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/pull/7');
  const card = g.$('.thread-tracked li .thread-work-icon')!;
  expect([card.getAttribute('title'), card.querySelector('svg')?.outerHTML]).toEqual(['Card', tab('deck')]);
});

it('marks each linked item with the icon its kind has in the glass views', async () => {
  const d = everyAttentionFleet(); d.focusToken = 'tok'; d.threads = [summary()];
  const dispatch = d.dispatches[0]!, report = d.reports[0]!, pr = d.prs[0]!;
  dispatch.title = 'Implement the navigation change';
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
  expect(g.$(`.thread-work-dispatch a[href="#dispatch/${dispatch.id}"]`)?.textContent).toBe(dispatch.title);
  // A dispatch neither the snapshot nor the thread can read keeps its link words.
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

/** A thread the helm started: its summary, two linked cards (one answerable inline, one gone), and a linked dispatch. */
function helmThread(d: GlassSnapshot): ThreadView {
  const second = 'decision:0a1b2c3e', gone = 'decision:0a1b2c3f';
  d.decisions = [KEY, second].map((key, i) => ({ key, thread: ID, title: i ? 'Approve in the glass?' : 'Use Helm?', detail: '', options: ['Yes', 'No'], attachments: [], askedBy: 'helm', askedAt: new Date(NOW - (2 - i) * 60_000).toISOString(), stateHash: `s${i}` }));
  d.attention = [KEY, second].map((key, i) => ({ kind: 'decision', key, id: key, verb: 'decision', ageSecs: 0, stateHash: `s${i}` }));
  d.threads = [{ ...summary(), startedBy: 'helm', cards: [KEY, second], unreadResponse: true, responseSeq: 1, seenThrough: 0 }];
  return { ...view(), startedBy: 'helm', unreadResponse: true, responseSeq: 1, seenThrough: 0, notes: { decided: [], open: [] },
    rounds: [{ at: AT, entries: [
      { by: 'helm', text: 'Parked traps came up on three cards tonight.', attachments: [], at: AT, seq: 1 },
      { card: KEY }, { card: gone }, { card: second },
    ] }],
    cards: [{ key: KEY, title: 'Use Helm?', options: ['Yes', 'No'], standing: true }, { key: second, title: 'Approve in the glass?', options: ['Yes', 'No'], standing: true }] };
}

it('marks a thread the helm started in the threads list', async () => {
  const d = fleet(); helmThread(d);
  d.threads!.push({ ...summary(), id: 'abcdef02-1234-4000-8000-abcdef012345', title: 'From you', cards: [] });
  const g = await page(d, { hash: '#helm' });
  expect(g.$(`#helm [data-thread="${ID}"] .thread-starter`)?.textContent).toBe('Started by the helm');
  expect(g.$(`#helm [data-thread="${ID}"] .thread-starter svg`)).not.toBeNull();
  expect(g.$(`#helm [data-thread="${ID}"] .dopen`)?.getAttribute('aria-label')).toBe('Unread response: Navigation, Started by the helm');
  expect(g.$('#helm [data-thread="abcdef02-1234-4000-8000-abcdef012345"] .thread-starter')).toBeNull();
});

it('shows linked cards inline, answers one from the thread, and keeps previous and next in its modal', async () => {
  const d = fleet(), detail = helmThread(d);
  const g = await page(d, { hash: `#thread/${ID}`, get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined, post: () => ({ status: 200, body: { ok: true } }) });
  expect(g.$('.thread-timeline .from-helm .thread-text')?.textContent).toBe('Parked traps came up on three cards tonight.');
  // The card replaced before it was answered is gone; the two that stand show their options in the thread.
  const cards = g.$$('.thread-timeline .thread-card-entry');
  expect(cards.map((el) => el.querySelector('button')?.textContent)).toEqual(['Use Helm?', 'Approve in the glass?']);
  expect(cards.map((el) => [...el.querySelectorAll('.dopt .dlabel')].map((o) => o.textContent))).toEqual([['Yes', 'No'], ['Yes', 'No']]);
  expect(g.$('.thread-card-entry .dkey')).toBeNull();
  // A card opened from the thread steps through the open cards as the deck does.
  (cards[0]!.querySelector('button') as HTMLElement).click(); await g.settle();
  expect(g.$('.dmodal')?.getAttribute('data-decision')).toBe(KEY);
  expect(g.$('.dmodal .dpos')?.textContent).toBe('1 of 2');
  await click(g, '.dmodal .dnext');
  expect(g.$('.dmodal')?.getAttribute('data-decision')).toBe('decision:0a1b2c3e');
  await click(g, '.dmodal .dprev');
  expect(g.$('.dmodal')?.getAttribute('data-decision')).toBe(KEY);
  await click(g, '.dmodal .x');
  expect(g.$('.dmodal')).toBeNull();
  // Answering in the thread answers the card: the same request the modal sends.
  const second = g.$$('.thread-card-entry')[1]!;
  (second.querySelector('.dopt') as HTMLElement).click(); await g.settle();
  (second.querySelector('.dsend') as HTMLElement).click(); await g.settle();
  expect(g.posts().map((p) => JSON.parse(p.body))).toContainEqual({ kind: 'decision-answer', payload: { key: 'decision:0a1b2c3e', option: 'Yes', files: [], submission: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
  expect(g.$$('.thread-card-entry')[1]?.querySelector('.danswered')?.textContent).toContain('answered');
});


it('keeps the new-decision alert away while Threads is open, the list or a conversation, and brings it back on leaving', async () => {
  const d = fleet(), detail = helmThread(d);
  const g = await page(d, { hash: '#prs', get: (url) => url.startsWith('/threads/') ? { status: 200, body: detail } : undefined });
  expect(g.$('.dalert .dalert-open')?.textContent).toContain('2 new decisions');
  await g.go('#helm');
  expect(g.$('.dalert')).toBeNull();
  await click(g, `#helm [data-thread="${ID}"] .dopen`);
  expect(g.$('.tsheet')).not.toBeNull();
  expect(g.$('.dalert')).toBeNull();
  await click(g, '.tsheet .rback');
  expect(g.$('.dalert')).toBeNull();
  await g.go('#prs');
  expect(g.$('.dalert .dalert-open')?.textContent).toContain('2 new decisions');
});
