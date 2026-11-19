import { expect, it } from 'vitest';
import { CommandWatchType, WatchRegistry, parseCommandWatchBatch, watchJson, watchConditionKey } from '../src/index.js';

it('rejects duplicate types, missing required methods and unsupported API majors before registration', () => {
  const registry = new WatchRegistry();
  registry.register(new CommandWatchType());
  expect(() => registry.register(new CommandWatchType())).toThrow('already installed');
  const incomplete = new CommandWatchType();
  Object.defineProperty(incomplete, 'present', { value: undefined });
  expect(() => new WatchRegistry().register(incomplete)).toThrow('implement present');
  const incompatible = new CommandWatchType();
  Object.defineProperty(incompatible, 'descriptor', { value: { ...incompatible.descriptor, apiVersion: 2 } });
  expect(() => new WatchRegistry().register(incompatible)).toThrow('descriptor');
});

it('preserves the custom-command checkpoint and partial-error protocol', () => {
  const result = parseCommandWatchBatch(
    JSON.stringify({
      cursor: 3,
      events: [{ seq: 3, kind: 'comment', summary: 'feedback', url: 'https://example.test/review' }],
      error: 'some results unavailable',
    }),
    '2',
    '2026-11-19T00:00:00Z',
  );
  expect(result).toMatchObject({
    cursor: '3',
    events: [{ id: '3', kind: 'comment', summary: 'feedback', data: { seq: 3, url: 'https://example.test/review' } }],
    failure: { kind: 'command' },
  });
  expect(() => parseCommandWatchBatch('{"cursor":{},"events":[]}', '2', '2026-11-19T00:00:00Z')).toThrow('cursor');
  expect(() => parseCommandWatchBatch('{"cursor":3,"events":[null]}', '2', '2026-11-19T00:00:00Z')).toThrow('object');
});

it('refuses non-JSON values rather than losing them during persistence or plugin transport', () => {
  for (const value of [NaN, Infinity, undefined, () => {}, { nested: undefined }, new Date()])
    expect(() => watchJson(value)).toThrow('JSON');
  expect(watchJson({ state: [0, 'cursor', true, null] })).toEqual({ state: [0, 'cursor', true, null] });
});

it('condition identities cannot collide when sources and conditions contain separators', () => {
  expect(watchConditionKey('fixture:a', 'b:c')).not.toBe(watchConditionKey('fixture:a:b', 'c'));
  expect(watchConditionKey('fixture:a', 'approval')).toBe(watchConditionKey('fixture:a', 'approval'));
});
