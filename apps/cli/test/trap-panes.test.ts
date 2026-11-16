import { expect, it, vi } from 'vitest';
import { createTrapPaneWatch } from '../src/trap-panes.js';

it('sweeps orphans at daemon startup and every five minutes, retrying departures each tick', () => {
  const reap = vi.fn(() => ['%7']);
  const log = vi.fn();
  const watch = createTrapPaneWatch(reap);
  watch(1000, log);
  watch(6000, log);
  watch(300_999, log);
  watch(301_000, log);
  expect(reap.mock.calls).toEqual([[true], [false], [false], [true]]);
  expect(log).toHaveBeenCalledWith('dead trap pane %7: tail saved and pane closed');
});

it('retries a failed startup sweep on the next tick', () => {
  const reap = vi.fn().mockImplementationOnce(() => { throw new Error('archive failed'); }).mockReturnValue([]);
  const watch = createTrapPaneWatch(reap);
  expect(() => watch(1000, () => {})).toThrow('archive failed');
  watch(6000, () => {});
  expect(reap.mock.calls).toEqual([[true], [true]]);
});
