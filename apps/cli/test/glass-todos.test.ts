import { afterEach, describe, expect, it } from 'vitest';
import type { TodoView } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom } from './glass-dom.js';
import { emptyFleet, NOW } from './fixtures/glass-snapshots.js';

const HOUR = 3600_000;
let pages: GlassDom[] = [];
afterEach(async () => {
  await Promise.all(pages.map((g) => g.close()));
  pages = [];
});

const todo = (fields: Partial<TodoView> & { id: number }): TodoView => ({
  grounds: 'home',
  groundsKey: 'fleet',
  text: `Task ${fields.id}`,
  createdAt: new Date(NOW - HOUR).toISOString(),
  done: false,
  stale: false,
  overdue: false,
  ...fields,
});

async function open(todos: TodoView[], hash = '#todos') {
  const d = emptyFleet();
  d.todos = todos;
  d.focusToken = 'page-token';
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash });
  pages.push(g);
  return g;
}
const row = (g: GlassDom, id: number) => g.$$('#todos .todo-check').find((el) => el.textContent?.includes(`#${id} `))!;
const clickIn = async (g: GlassDom, root: Element, text: string) => {
  [...root.querySelectorAll('button')].find((b) => b.textContent === text)!.click();
  await g.settle();
};

describe('todo chips', () => {
  it('a future due shows a dim chip with its day and time', async () => {
    const g = await open([todo({ id: 1, dueAt: new Date(NOW + 24 * HOUR).toISOString() })]);
    const chip = row(g, 1).querySelector('.badge')!;
    expect(chip.className).toContain('dim');
    expect(chip.textContent).toMatch(/^due \w{3} \d{2}:\d{2}$/);
  });

  it('a far-off due names the date', async () => {
    const g = await open([todo({ id: 1, dueAt: new Date(NOW + 20 * 24 * HOUR).toISOString() })]);
    expect(row(g, 1).querySelector('.badge')!.textContent).toMatch(/^due \w{3} \d+ \d{2}:\d{2}$/);
  });

  it('an overdue todo shows a warn chip with its age', async () => {
    const g = await open([todo({ id: 1, overdue: true, dueAt: new Date(NOW - 2 * HOUR).toISOString() })]);
    const chip = row(g, 1).querySelector('.badge.warn')!;
    expect(chip.textContent).toMatch(/^overdue /);
    expect(row(g, 1).textContent).not.toContain('due ' + 'Mon');
  });

  it('a fired todo shows a warn chip with the event, and no longer says what it waits on', async () => {
    const g = await open([todo({ id: 1, overdue: true, firedBy: 'pr:o/r#1 merged', waitingOn: '✓ pr:o/r#1 merged (any)' })]);
    expect(row(g, 1).querySelector('.badge.warn')!.textContent).toBe('fired: pr:o/r#1 merged');
    expect(row(g, 1).textContent).not.toContain('waiting on');
  });

  it('a waiting todo says what it waits on', async () => {
    const g = await open([todo({ id: 1, waitingOn: 'pr:o/r#1 merged (any)' })]);
    expect(row(g, 1).textContent).toContain('waiting on pr:o/r#1 merged (any)');
  });

  it('a repeating todo shows its rule, and done today when it was', async () => {
    const dueAt = new Date(NOW + 24 * HOUR).toISOString();
    const g = await open([
      todo({ id: 1, dueAt, every: 'weekly fri 09:00', lastDoneAt: new Date(NOW).toISOString() }),
      todo({ id: 2, dueAt, every: 'daily 09:00', lastDoneAt: new Date(NOW - 7 * 24 * HOUR).toISOString() }),
    ]);
    expect(row(g, 1).textContent).toContain('every weekly fri 09:00');
    expect(row(g, 1).textContent).toContain('done today');
    expect(row(g, 2).textContent).not.toContain('done today');
  });

  it('shows how often it was snoozed, only when it was', async () => {
    const dueAt = new Date(NOW + HOUR).toISOString();
    const g = await open([todo({ id: 1, dueAt, snoozes: 3 }), todo({ id: 2, dueAt })]);
    expect(row(g, 1).textContent).toContain('snoozed 3×');
    expect(row(g, 2).textContent).not.toContain('snoozed');
  });

  it('a stale todo keeps its badge', async () => {
    const g = await open([todo({ id: 1, stale: true })]);
    expect(row(g, 1).querySelector('.badge.warn')!.textContent).toBe('stale');
  });

  it('a done row shows no chip and no button', async () => {
    const g = await open([todo({ id: 1, done: true, dueAt: new Date(NOW + HOUR).toISOString() }), todo({ id: 2 })], '#deck');
    const done = g.$$('#deck .todo-check')[0]!;
    expect(done.querySelector('.badge')).toBeNull();
    expect(done.querySelector('button')).toBeNull();
  });
});

describe('the schedule box', () => {
  it('offers Set a time with no due, and Snooze with one', async () => {
    const g = await open([todo({ id: 1 }), todo({ id: 2, dueAt: new Date(NOW + HOUR).toISOString() })]);
    expect(row(g, 1).querySelector('button')!.textContent).toBe('Set a time');
    expect(row(g, 2).querySelector('button')!.textContent).toBe('Snooze');
  });

  it('offers Snooze on a todo that fired with no due of its own', async () => {
    const g = await open([todo({ id: 1, overdue: true, firedBy: 'pr:o/r#1 merged' })]);
    expect(row(g, 1).querySelector('button')!.textContent).toBe('Snooze');
  });

  it('a preset fills the field; Save posts the storage grounds, the id and the time', async () => {
    const g = await open([todo({ id: 4 })]);
    await clickIn(g, row(g, 4), 'Set a time');
    await clickIn(g, row(g, 4), 'Tomorrow 09:00');
    expect((row(g, 4).querySelector('input[name=until]') as HTMLInputElement).value).toBe('tomorrow 09:00');
    row(g, 4).querySelector('form')!.dispatchEvent(new g.window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    await g.settle();
    const post = g.posts().find((p) => p.url.includes('/requests'))!;
    expect(JSON.parse(post.body)).toEqual({ kind: 'todo-schedule', payload: { grounds: 'fleet', id: 4, until: 'tomorrow 09:00' } });
    expect(post.headers['x-lobstah-token']).toBe('page-token');
  });

  it('the +2h preset sends a duration', async () => {
    const g = await open([todo({ id: 4 })]);
    await clickIn(g, row(g, 4), 'Set a time');
    await clickIn(g, row(g, 4), '+2h');
    expect((row(g, 4).querySelector('input[name=until]') as HTMLInputElement).value).toBe('2h');
  });

  it('Save is disabled until there is a time, and Cancel closes the box', async () => {
    const g = await open([todo({ id: 4 })]);
    await clickIn(g, row(g, 4), 'Set a time');
    const save = [...row(g, 4).querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await clickIn(g, row(g, 4), 'Cancel');
    expect(row(g, 4).querySelector('form')).toBeNull();
  });
});

describe('the Deck preview', () => {
  it('still lists at most five rows, with chips and no button', async () => {
    const dueAt = new Date(NOW + HOUR).toISOString();
    const g = await open(Array.from({ length: 8 }, (_, i) => todo({ id: i + 1, dueAt })), '#deck');
    const rows = g.$$('#deck .todo-check');
    expect(rows).toHaveLength(5);
    expect(rows[0]!.querySelector('.badge')).not.toBeNull();
    expect(rows[0]!.querySelector('button')).toBeNull();
    expect(g.$('#deck .todos .deckmore')!.textContent).toBe('More (3)');
  });
});
