import { afterEach, describe, expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass, type GlassDom } from './glass-dom.js';
import { acceptanceFleet, NOW, ago } from './fixtures/glass-snapshots.js';

const opened: GlassDom[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(g => g.close())); });
const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
async function click(g: GlassDom, selector: string) { (g.$(selector) as unknown as HTMLElement).click(); await g.settle(); }
function fleet() {
  const d = acceptanceFleet();
  const x = d.dispatches.find(x => x.id.startsWith('cccccccc'))!;
  x.title = 'Keep the checkout draft';
  x.brief = '# Keep the checkout draft\n\nRender the **complete brief**.\n\n- Check retry\n- Check restore';
  x.note = 'The latest note is complete.';
  x.log = [{at:ago(600_000),verb:'working',note:'Started the work.'},{at:ago(120_000),verb:'paused',note:'Waiting for review.'}];
  x.verb = 'paused'; x.verbAt = ago(120_000);
  x.waiting = {on:'review',since:ago(120_000),link:'https://example.com/review'};
  x.messages = [{file:'001.msg', from:'helm',state:'delivered',at:ago(240_000),text:'Keep the current branch.'}, {file:'002.msg',from:'Chris',state:'pending',at:ago(60_000),text:'Check the phone view.'}];
  d.prs = [{...d.prs[0]!,dispatchIds:[x.id],mine:true}];
  x.evidence = {prUrl:d.prs[0]!.url};
  d.reports = [{key:'report:work:'+x.id,dispatch:x.id,lane:x.lane,title:'Checkout findings',author:'steady-crab',filedAt:ago(100_000),stateHash:'report',bytes:10,attachments:[]}];
  const trap = d.traps[0]!;
  trap.name = 'steady-crab'; trap.claimed = x.id; trap.catches = [x.id,d.dispatches[0]!.id]; trap.totalCatches = 24;
  trap.model = 'model-one'; trap.config = {effort:'high',permissionMode:'auto'};
  return {d,x,trap};
}
async function page(hash: string) {
  const f = fleet();
  const g = await loadGlass(GLASS_PAGE, f.d, {now:NOW,hash,prefs:{view:'cards'},files:{['/report/'+encodeURIComponent(f.d.reports[0]!.key)+'/meta']:JSON.stringify(f.d.reports[0]),['/report/'+encodeURIComponent(f.d.reports[0]!.key)+'/md']:'# Checkout findings\n\nThe report stays over its dispatch.'},get:url=>url.startsWith('/data/pr/')?{status:404,body:{}}:undefined});
  opened.push(g); return {g,...f};
}

describe('the dispatch view', () => {
  it('shows current work and shared output cards before the Markdown brief and newest-first activity', async () => {
    const f=fleet(); const {g,x}=await page('#dispatch/'+encodeURIComponent('work:'+f.x.id));
    expect(text(g.$('.pr-view-head h2'))).toBe(x.title);
    expect(text(g.$('.view-meta'))).toContain('steady-crab');
    expect(g.$$('.detail-scroll > section > h4').map(text)).toEqual(['Now 2m ago','PRs','Report','Brief','Activity','Messages']);
    expect(g.$('.dispatch-brief strong')?.textContent).toBe('complete brief');
    expect(g.$('.dispatch-prs .card .pricon')).not.toBeNull();
    expect(g.$('.dispatch-report .card')?.textContent).toContain('Checkout findings');
    expect(text(g.$('.dispatch-activity .view-event'))).toContain('Waiting for review.');
    expect(g.$('.dispatch-activity .verbicon')).not.toBeNull();
    expect(text(g.$('.view-messages'))).toContain('from Chris · pending');
    expect(text(g.$('.view-messages'))).toContain('from helm · delivered');
    expect(g.$('.detail-actions, .jobmsg')).toBeNull();
    expect(g.$('.view-details')?.hasAttribute('open')).toBe(false);
    for(const age of g.$$('.detail-scroll [data-age]')) expect(age.getAttribute('title')).toBe(age.getAttribute('data-age'));
    expect(text(g.$('.dispatch-activity'))).not.toMatch(/2026-\d\d-\d\dT/);
  });
  it('opens its real PR card and Back returns to that dispatch, then to the underlying tab and scroll', async () => {
    const {g,x}=await page('#dispatches');
    g.setScroll(440);
    const card=g.$$('#dispatches .card').find(card=>text(card).includes(x.title))!;
    (card as unknown as HTMLElement).click();await g.settle();
    await click(g,'.dispatch-prs .card');
    expect(g.window.location.hash).toBe('#pr/pr%3Aacme%2Fweb%2341');
    await click(g,'.detail-close');
    expect(text(g.$('.pr-view-head h2'))).toBe(x.title);
    await click(g,'.detail-close');
    expect(g.$('.detail-frame')).toBeNull();
    expect(g.window.location.hash).toBe('#dispatches');
    expect(g.window.scrollY).toBe(440);
  });
  it('opens the shared report card over the dispatch and Back returns to its work', async () => {
    const f=fleet(); const {g,x}=await page('#dispatch/'+encodeURIComponent('work:'+f.x.id));
    await click(g,'.dispatch-report .card');
    expect(g.window.location.hash).toContain('#report/');
    expect(text(g.$('.rsheet'))).toContain('The report stays over its dispatch.');
    g.window.history.back();await g.settle();
    expect(g.$('.rsheet')).toBeNull();
    expect(text(g.$('.pr-view-head h2'))).toBe(x.title);
  });
  it('omits empty sections and does not offer local cancellation', async () => {
    const d=fleet(); const x=d.x;
    x.note=undefined;x.evidence=undefined;x.prList=undefined;x.log=[];x.inbox=[];x.messages=[];x.brief='';x.attachments=[];
    d.d.prs=[];d.d.reports=[];
    const g=await loadGlass(GLASS_PAGE,d.d,{now:NOW,hash:'#dispatch/'+encodeURIComponent('work:'+x.id)});opened.push(g);
    expect(g.$('.dispatch-now, .dispatch-prs, .dispatch-report, .dispatch-brief, .dispatch-activity, .view-messages')).toBeNull();
    expect(g.$('.detail-open .splitcaret')).toBeNull();
  });
});

describe('the trap view', () => {
  it('shows its current dispatch and catches as shared cards, then folded history', async () => {
    const {g,trap}=await page('#trap-view/t1');
    expect(text(g.$('.pr-view-head h2'))).toBe('🪤 steady-crab');
    expect(text(g.$('.view-meta'))).toContain('Claude · model-one · auto · high');
    expect(text(g.$('.trap-current .card'))).toContain('Keep the checkout draft');
    expect(text(g.$('.trap-catches'))).toContain('24 all time');
    expect(g.$$('.trap-catches .card')).toHaveLength(1);
    expect(g.$('.trap-lifecycle')?.hasAttribute('open')).toBe(false);
    expect(g.$('.trap-details')?.hasAttribute('open')).toBe(false);
    await click(g,'.trap-current .card');
    expect(g.window.location.hash).toContain('#dispatch/');
    await click(g,'.detail-close');
    expect(g.window.location.hash).toBe('#trap-view/'+trap.trapId);
    expect(text(g.$('.pr-view-head h2'))).toBe('🪤 steady-crab');
  });
  it('shows start commands in place of current work, and an idle trap listens for work', async () => {
    const f=fleet();f.trap.claimed=undefined;f.trap.catches=[];f.trap.totalCatches=0;f.trap.messages=[];f.trap.notices=[];
    const g=await loadGlass(GLASS_PAGE,f.d,{now:NOW,hash:'#trap-view/t1'});opened.push(g);
    expect(text(g.$('.trap-current'))).toBe('Listening for work');
    expect(g.$('.trap-catches, .trap-lifecycle, .view-messages')).toBeNull();
    f.trap.live=false;f.trap.starting={reservedAt:ago(60_000),deadline:ago(-60_000),commands:[{harness:'claude',command:'lobstah soak --ticket one'}]};
    g.serve(f.d);await g.poll();
    expect(g.$('.trap-current')).toBeNull();
    expect(text(g.$('.trap-start'))).toContain('lobstah soak --ticket one');
    expect(text(g.$('.trap-start'))).toContain('Reserved 60s ago');
  });
});
