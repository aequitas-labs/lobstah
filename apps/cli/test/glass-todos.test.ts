import { afterEach, describe, expect, it } from 'vitest';
import type { TodoView } from '@lobstah/core';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import type { GlassDom, GlassDomOptions } from './glass-dom.js';
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

async function open(todos: TodoView[], hash = '#todos', options: Partial<GlassDomOptions> = {}) {
  const d = emptyFleet();
  d.todos = todos;
  d.focusToken = 'page-token';
  const g = await loadGlass(GLASS_PAGE, d, { now: NOW, hash, ...options });
  pages.push(g);
  return g;
}
const row = (g: GlassDom, id: number) => g.$$('#todos .todo-check').find((el) => el.textContent?.includes(`#${id} `))!;
const clickIn = async (g: GlassDom, root: Element, text: string) => {
  [...root.querySelectorAll('button')].find((b) => b.textContent === text)!.click();
  await g.settle();
};
const editor = (g: GlassDom) => g.$('.todo-snooze-popover, .todo-snooze-sheet')!;
const snooze = async (g: GlassDom, id: number) => {
  (row(g, id).querySelector('.todo-schedule-open') as HTMLButtonElement).click();
  await g.settle();
};
/** Touches exercise the row's real gesture handler without asserting its CSS. */
const swipe = async (g: GlassDom, root: Element, from: [number, number], to: [number, number]) => {
  for (const [type, point, property] of [
    ['touchstart', from, 'touches'],
    ['touchend', to, 'changedTouches'],
  ] as const) {
    const event = new g.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, property, { value: [{ clientX: point[0], clientY: point[1] }] });
    root.dispatchEvent(event as unknown as Event);
  }
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
    const g = await open([todo({ id: 1, done: true, dueAt: new Date(NOW + HOUR).toISOString() }), todo({ id: 2 })]);
    const done = g.$$('#todos .todo-done-today .todo-check')[0]!;
    expect(done.querySelector('.badge')).toBeNull();
    expect(done.querySelector('button')).toBeNull();
  });
});

describe('snoozing a todo', () => {
  it('offers one named clock with or without an existing due time, keeping the checkbox read-only', async () => {
    const g = await open([todo({ id: 1 }), todo({ id: 2, dueAt: new Date(NOW + HOUR).toISOString() })]);
    for (const id of [1, 2]) {
      const button = row(g, id).querySelector('button')!;
      expect(button.getAttribute('aria-label')).toBe('Snooze');
      expect((row(g, id).querySelector('input') as HTMLInputElement).disabled).toBe(true);
    }
  });

  it('offers Snooze on a todo that fired with no due of its own', async () => {
    const g = await open([todo({ id: 1, overdue: true, firedBy: 'pr:o/r#1 merged' })]);
    expect(row(g, 1).querySelector('button')!.getAttribute('aria-label')).toBe('Snooze');
  });

  it('a preset fills the field; Snooze posts the storage grounds, the id and the time', async () => {
    const g = await open([todo({ id: 4 })]);
    await snooze(g, 4);
    await clickIn(g, editor(g), 'Tomorrow 09:00');
    expect((editor(g).querySelector('input[name=until]') as HTMLInputElement).value).toBe('tomorrow 09:00');
    editor(g)
      .querySelector('form')!
      .dispatchEvent(new g.window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    await g.settle();
    const post = g.posts().find((p) => p.url.includes('/requests'))!;
    expect(JSON.parse(post.body)).toEqual({ kind: 'todo-schedule', payload: { grounds: 'fleet', id: 4, until: 'tomorrow 09:00' } });
    expect(post.headers['x-lobstah-token']).toBe('page-token');
  });

  it('keeps one save pending, then closes the editor and announces the resolved time', async () => {
    let finish!: (answer: { status: number; body: unknown }) => void;
    const g = await open([todo({ id: 4 })], '#todos', {
      post: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await snooze(g, 4);
    await clickIn(g, editor(g), '+2h');
    const save = [...editor(g).querySelectorAll('button')].find((button) => button.textContent === 'Snooze') as HTMLButtonElement;
    save.click();
    await g.settle();
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-busy')).toBe('true');
    save.click();
    expect(g.posts()).toHaveLength(1);
    const dueAt = new Date(NOW + 2 * HOUR).toISOString();
    finish({ status: 201, body: { ok: true, dueAt } });
    await g.settle();
    expect(editor(g)).toBeNull();
    expect(g.$('[role="status"]')?.textContent).toMatch(/^Snoozed #4 until \w{3} \d{2}:\d{2}$/);
  });

  it('keeps a refused time editable and allows another attempt', async () => {
    let attempts = 0;
    const g = await open([todo({ id: 4 })], '#todos', {
      post: () =>
        ++attempts === 1
          ? { status: 400, body: { ok: false, reason: "couldn't read 'mon 9'" } }
          : { status: 201, body: { ok: true, dueAt: new Date(NOW + HOUR).toISOString() } },
    });
    await snooze(g, 4);
    await clickIn(g, editor(g), '+2h');
    await clickIn(g, editor(g), 'Snooze');
    expect(editor(g).querySelector('[role="alert"]')?.textContent).toBe("couldn't read 'mon 9'");
    await clickIn(g, editor(g), 'Snooze');
    expect(editor(g)).toBeNull();
    expect(attempts).toBe(2);
  });

  it('the +2h preset sends a duration', async () => {
    const g = await open([todo({ id: 4 })]);
    await snooze(g, 4);
    await clickIn(g, editor(g), '+2h');
    expect((editor(g).querySelector('input[name=until]') as HTMLInputElement).value).toBe('2h');
  });

  it('Snooze is disabled until there is a time, and clicking outside closes the editor', async () => {
    const g = await open([todo({ id: 4 })]);
    await snooze(g, 4);
    const save = [...editor(g).querySelectorAll('button')].find((b) => b.textContent === 'Snooze') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    g.document.body.dispatchEvent(new g.window.Event('pointerdown', { bubbles: true }) as unknown as Event);
    await g.settle();
    expect(editor(g)).toBeNull();
  });

  it('a horizontal phone swipe reveals Snooze and opens the shared sheet; vertical scrolling does not', async () => {
    const g = await open([todo({ id: 4 })], '#todos', { prepare: (window) => Object.defineProperty(window, 'innerWidth', { value: 375 }) });
    await swipe(g, row(g, 4), [220, 30], [180, 180]);
    expect(row(g, 4).querySelector('.todo-swipe-snooze')).toBeNull();
    await swipe(g, row(g, 4), [220, 30], [100, 35]);
    (row(g, 4).querySelector('.todo-swipe-snooze') as HTMLButtonElement).click();
    await g.settle();
    expect(editor(g).getAttribute('aria-modal')).toBe('true');
    expect(editor(g).querySelector('h3')!.textContent).toBe('Snooze #4 until');
  });

  it('Escape closes the desktop popover and returns focus to the clock', async () => {
    const g = await open([todo({ id: 4 })]);
    await snooze(g, 4);
    expect(editor(g).getAttribute('aria-modal')).not.toBe('true');
    g.document.dispatchEvent(new g.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
    await g.settle();
    expect(editor(g)).toBeNull();
    expect(g.document.activeElement).toBe(row(g, 4).querySelector('.todo-schedule-open'));
  });
});

describe('the Deck preview', () => {
  it('still lists at most five rows, with chips and a Snooze clock on every open row', async () => {
    const dueAt = new Date(NOW + HOUR).toISOString();
    const g = await open(
      Array.from({ length: 8 }, (_, i) => todo({ id: i + 1, dueAt })),
      '#deck',
    );
    const rows = g.$$('#deck .todo-check');
    expect(rows).toHaveLength(5);
    expect(rows[0]!.querySelector('.badge')).not.toBeNull();
    expect(rows.every((row) => row.querySelector('button')?.getAttribute('aria-label') === 'Snooze')).toBe(true);
    expect(g.$('#deck .todos .deckmore')!.textContent).toBe('More (3)');
  });
});

describe('the count', () => {
  // 25 open and 50 done since 04:00, as Chris's glass had: the count is of the 25.
  const mix = () => [
    ...Array.from({ length: 50 }, (_, i) => todo({ id: i + 1, done: true })),
    ...Array.from({ length: 25 }, (_, i) => todo({ id: 51 + i })),
  ];
  const openRows = (g: GlassDom, tab: string) => g.$$(`#${tab} .todos > .todo-checklist > .todo-check`);

  it('the Deck shows the first five open todos and More counts the other open ones, never the done ones', async () => {
    const g = await open(mix(), '#deck');
    const rows = openRows(g, 'deck');
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => !r.classList.contains('done'))).toBe(true);
    expect(g.$('#deck .todos .deckmore')!.textContent).toBe('More (20)');
    const done = g.$('#deck .todos .todo-done-today')!;
    expect(done.textContent).toBe('50 done today');
    expect(done.getAttribute('href')).toBe('#todos');
  });

  it('the page lists every open todo, and the done ones apart, in a closed Done today section', async () => {
    const g = await open(mix());
    expect(openRows(g, 'todos')).toHaveLength(25);
    const done = g.$('#todos .todo-done-today') as HTMLDetailsElement;
    expect(done.open).toBe(false);
    expect(done.querySelector('summary')!.textContent).toBe('Done today (50)');
    expect(done.querySelectorAll('.todo-check.done')).toHaveLength(50);
    expect(g.$('#todos .empty')).toBeNull();
  });

  it('with only done todos, says none is open and counts nothing', async () => {
    const g = await open([todo({ id: 1, done: true }), todo({ id: 2, done: true })], '#deck');
    expect(openRows(g, 'deck')).toHaveLength(0);
    expect(g.$('#deck .todos .empty')!.textContent).toBe('No open TODOs');
    expect(g.$('#deck .todos .deckmore')).toBeNull();
    expect(g.$('#deck .todos .todo-done-today')!.textContent).toBe('2 done today');
  });

  it('with only open todos, has no done line', async () => {
    const g = await open([todo({ id: 1 }), todo({ id: 2 })], '#deck');
    expect(openRows(g, 'deck')).toHaveLength(2);
    expect(g.$('#deck .todos .todo-done-today')).toBeNull();
  });
});
