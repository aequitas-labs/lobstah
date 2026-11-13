import { afterEach, describe, expect, it } from 'vitest';
import type { GlassDispatch, GlassFullSnapshot, GlassTrap } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { NOW, acceptanceFleet, ago, trapStatesFleet } from './fixtures/glass-snapshots.js';
import { VERB_TONE, isIconVerb, verbIconLabel } from '../../../packages/glass-ui/ui/components/run-status.js';
import { stateIconName } from '../../../packages/glass-ui/ui/components/icons.js';
import type { VerbIconVerb } from '../../../packages/glass-ui/ui/components/run-status.js';

/**
 * A dispatch's verb is an icon in a small pill on its card and deck row
 * (components/run-status.ts VerbIcon), and every state has one colour
 * meaning: amber in progress, green done or idle and listening, grey paused,
 * not listening or signed off, red blocked or failed, blue needs a decision.
 */

let pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.map((g) => g.close()));
  pages = [];
});
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const MIN = 60_000;

async function page(d: GlassFullSnapshot, hash: string, view: 'cards' | 'table' = 'cards'): Promise<GlassDom> {
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash, prefs: { view } });
  pages.push(g);
  return g;
}

/** Each verb: its icon's tone, its accessible name, and a mark of its drawing. */
const VERBS: Array<{ verb: VerbIconVerb; tone: string; label: string; draws: string }> = [
  { verb: 'working', tone: 'warn', label: 'Working · 12m', draws: '.runspin' },
  { verb: 'needs-decision', tone: 'info', label: 'Needs decision · 5m · waiting on person', draws: 'g[transform] path' },
  { verb: 'blocked', tone: 'bad', label: 'Blocked · 40s', draws: 'path[d^="M5.6 2.2"]' },
  { verb: 'paused', tone: 'dim', label: 'Paused · 3.0h · waiting on heavy', draws: 'rect + rect' },
  { verb: 'done', tone: 'ok', label: 'Done · 2m', draws: 'path[d="M3 8.5l3.2 3.2L13 4.8"]' },
  { verb: 'failed', tone: 'bad', label: 'Failed · 8m', draws: 'path[d="M4 4l8 8M12 4l-8 8"]' },
];
const SINCE: Record<VerbIconVerb, number> = { working: 12 * MIN, 'needs-decision': 5 * MIN, blocked: 40_000, paused: 180 * MIN, done: 2 * MIN, failed: 8 * MIN, queued: MIN, limited: MIN, unknown: MIN };
const WAITING: Partial<Record<VerbIconVerb, string>> = { 'needs-decision': 'person', paused: 'heavy' };

/** One in-flight dispatch in each verb, newest first in the list's order. */
function verbsFleet(): GlassFullSnapshot {
  const d = acceptanceFleet();
  const base = d.dispatches.find((x) => x.id.startsWith('bbbbbbbb'))!;
  d.dispatches = VERBS.map(({ verb }, i): GlassDispatch => {
    const on = WAITING[verb];
    return {
      ...base,
      id: `${i + 1}${i + 1}${i + 1}${i + 1}aaaa-0000-4000-8000-00000000000${i + 1}`,
      followUp: undefined,
      evidence: undefined,
      prBadge: undefined,
      prHead: undefined,
      brief: `A ${verb} dispatch`,
      verb,
      verbAt: ago(SINCE[verb]),
      waiting: on ? { on, since: ago(SINCE[verb]), waitedSecs: SINCE[verb] / 1000 } : undefined,
      sort: NOW - i * MIN,
    };
  });
  d.attention = [];
  d.landed = [];
  return d;
}

describe('a verb icon', () => {
  it('distinguishes a usage limit from paused or failed and resolves domain state labels', () => {
    expect(stateIconName('limited')).toBe('limited');
    expect(stateIconName('paused')).toBe('paused');
    expect(stateIconName('failed')).toBe('failed');
    expect(stateIconName('not listening')).toBe('not-listening');
    expect(stateIconName('request_changes')).toBe('changes-requested');
    expect(stateIconName('checks 2/3 failed')).toBe('failed');
    expect(stateIconName('checks 2/3')).toBe('waiting');
    expect(stateIconName('checks unknown')).toBe('unknown');
    expect(stateIconName('needs-app-start')).toBe('starting');
    expect(stateIconName('toString')).toBe('unknown');
  });

  it('says the verb, how long it has been in it, and what it waits on', () => {
    const at = new Date(Date.now() - 12 * MIN).toISOString();
    expect(verbIconLabel('working', at)).toBe('Working · 12m');
    expect(verbIconLabel('paused', at, 'review')).toBe('Paused · 12m · waiting on review');
    expect(verbIconLabel('needs-decision')).toBe('Needs decision');
  });

  it('has one tone per verb, and all dispatch states have icons', () => {
    expect(VERB_TONE).toEqual({ working: 'warn', 'needs-decision': 'info', blocked: 'bad', paused: 'dim', done: 'ok', failed: 'bad', queued: 'dim', limited: 'bad', unknown: 'dim' });
    expect(['queued', 'limited', 'unknown', 'toString'].filter(isIconVerb)).toEqual(['queued', 'limited', 'unknown']);
  });
});

describe('a dispatch card', () => {
  it.each(VERBS)('shows $verb as its icon in a $tone pill, named "$label"', async ({ verb, tone, label, draws }) => {
    const g = await page(verbsFleet(), '#dispatches');
    const card = g.$$('#dispatches .card').find((c) => text(c.querySelector('.gtitle')) === `A ${verb} dispatch`)!;
    const icon = card.querySelector('.gtop .verbicon')!;
    expect(icon.className).toBe(`runicon verbicon verb-${verb} ${tone}`);
    expect(icon.getAttribute('role')).toBe('img');
    expect(icon.getAttribute('aria-label')).toBe(label);
    expect(icon.getAttribute('title')).toBe(label);
    expect(icon.querySelector(`svg[aria-hidden="true"] ${draws}`)).toBeTruthy();
    // The word is the icon's name, not its text: no chip, no emoji.
    expect(card.querySelector('.gtop .gchip')).toBeNull();
    expect(text(icon)).toBe('');
  });

  it('keeps the still dot under the working spinner, which glass.css shows with less motion', async () => {
    const g = await page(verbsFleet(), '#dispatches');
    const working = g.$('#dispatches .verbicon.verb-working')!;
    expect(working.querySelector('.runspin')).toBeTruthy();
    expect(working.querySelector('.rundot')).toBeTruthy();
  });

  it.each(['queued', 'limited', 'unknown'] as const)('names a %s dispatch icon for screen readers', async (verb) => {
    const d = verbsFleet();
    d.dispatches[0] = { ...d.dispatches[0]!, verb, bucket: 'queued' };
    const g = await page(d, '#dispatches');
    const card = g.$$('#dispatches .card').find((c) => text(c.querySelector('.gtitle')) === 'A working dispatch')!;
    expect(card.querySelector(`.verb-${verb}`)?.getAttribute('aria-label')).toContain(verb.charAt(0).toUpperCase() + verb.slice(1));
    expect(card.querySelector(`.verb-${verb} svg`)).not.toBeNull();
  });
});

describe('the deck', () => {
  it('ends each in-flight row with its verb icon, cards and rows alike', async () => {
    for (const view of ['cards', 'table'] as const) {
      const g = await page(verbsFleet(), '#deck', view);
      const inflight = g.$$('#deck section')[1]!;
      const icons = [...inflight.querySelectorAll('.verbicon')].map((i) => i.getAttribute('aria-label'));
      expect(icons, view).toEqual(VERBS.map((v) => v.label));
    }
  });
});

describe('one colour meaning', () => {
  it('colors a verb in the dispatches table as its icon', async () => {
    const g = await page(verbsFleet(), '#dispatches', 'table');
    const color = (verb: string) => g.window.getComputedStyle(g.$(`#dispatches td.v-${verb}`) as never).getPropertyValue('color');
    expect(color('working')).toBe('#e2b93d');
    expect(color('needs-decision')).toBe('#58a6ff');
    expect(color('blocked')).toBe('#e26d5c');
    expect(color('failed')).toBe('#e26d5c');
    expect(color('paused')).toBe('#8b96a5');
    expect(color('done')).toBe('#4fc17c');
  });

  it('dots a trap amber working or starting, green idle and listening, grey parked, not listening or signed off, red start failed', async () => {
    const d = trapStatesFleet();
    const reserved = (id: string, failed: boolean): GlassTrap => ({
      trapId: id,
      repo: 'web',
      live: false,
      starting: { reservedAt: ago(MIN), deadline: ago(-2 * MIN), ...(failed ? { failedAt: ago(1_000), reason: 'no session signed on by 12:03' } : {}) },
      messages: [],
      notices: [],
      catches: [],
    });
    const signedOff = { ...d.traps.find((t) => t.trapId === 'stale')!, trapId: 'gone', live: false };
    d.traps.push(reserved('starting', false), reserved('failed', true), signedOff);
    // By trap id: working, starting, listening, parked, not listening (stale), signed off (gone), start failed.
    const want: Record<string, string> = { working: 'warn', starting: 'warn', listening: 'ok', parked: 'dim', stale: 'dim', gone: 'dim', failed: 'bad' };
    const g = await page(d, '#traps', 'table');
    const rows = g.$$('#traps tr.rowhead');
    const got = Object.fromEntries(
      Object.keys(want).map((id) => {
        const row = rows.find((r) => text(r.querySelector('.trap-address')) === `wt:${id}`)!;
        const dot = row.querySelector('.trapdot')!;
        return [id, [...dot.classList].filter((c) => c !== 'dot' && c !== 'trapdot').join(' ')];
      }),
    );
    expect(got).toEqual(want);
    // The cards' chips stay words, in the same tones.
    const cards = await page(d, '#traps');
    for (const [id, tone] of Object.entries(want)) {
      const card = cards.$$('#traps .card').find((c) => c.querySelector('.gtitle')?.getAttribute('title') === `wt:${id}`)!;
      expect(card.querySelector('.gtop .gchip')!.className, id).toBe(`gchip ${tone}`);
    }
  });

  it("greys a trap's not-listening column", async () => {
    const g = await page(trapStatesFleet(), '#traps', 'table');
    const stale = g.$$('#traps tr.rowhead').find((r) => text(r).includes('stale trap'))!;
    const listen = [...stale.querySelectorAll('td')].find((td) => text(td) === 'not listening')!;
    expect(listen.querySelector('.dot')!.className).toBe('dot dim');
  });
});
