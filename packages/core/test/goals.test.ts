import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { claimGoalsPrompt, goalDate, goalsFile, loadConfig, readGoals, setGoals, setGoalsRecap } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-goals-')); process.env.LOBSTAH_HOME = home; });
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it.each([
  ['2026-10-15T07:59:59Z', 'America/New_York', '2026-10-14'],
  ['2026-10-15T08:00:00Z', 'America/New_York', '2026-10-15'],
  ['2026-01-01T03:59:59Z', 'UTC', '2025-12-31'],
  ['2026-01-01T04:00:00Z', 'UTC', '2026-01-01'],
  ['2026-10-15T18:59:59Z', 'Asia/Tokyo', '2026-10-15'],
  ['2026-10-15T19:00:00Z', 'Asia/Tokyo', '2026-10-16'],
  ['2026-03-08T07:59:59Z', 'America/New_York', '2026-03-07'],
  ['2026-03-08T08:00:00Z', 'America/New_York', '2026-03-08'],
  ['2026-11-01T08:59:59Z', 'America/New_York', '2026-10-31'],
  ['2026-11-01T09:00:00Z', 'America/New_York', '2026-11-01'],
])('04:00 day boundary: %s in %s', (at, zone, expected) => {
  expect(goalDate(new Date(at), zone)).toBe(expected);
});

it('defaults to the system timezone and validates the configured IANA zone', () => {
  const now = new Date('2026-10-15T05:00:00Z');
  expect(goalDate(now)).toBe(goalDate(now, Intl.DateTimeFormat().resolvedOptions().timeZone));
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntimezone = "Asia/Tokyo"');
  expect(loadConfig().helm.timezone).toBe('Asia/Tokyo');
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\ntimezone = "not/a/zone"');
  expect(() => loadConfig()).toThrow('[helm].timezone');
});

it('writes readable daily markdown; goal replacement preserves recap and past days', () => {
  setGoals('fleet', '2026-10-14', ['Ship it', 'Review evidence']);
  setGoalsRecap('fleet', '2026-10-14', '## Recap\n\nDone: shipped.\nStuck: review.');
  setGoals('fleet', '2026-10-14', ['New wording']);
  setGoals('fleet', '2026-10-15', ['Next day']);
  expect(fs.readFileSync(goalsFile('fleet', '2026-10-14'), 'utf8')).toBe('# Goals for 2026-10-14\n\n- New wording\n\n## Recap\n\nDone: shipped.\nStuck: review.\n');
  expect(readGoals('fleet', '2026-10-15').lines).toEqual(['Next day']);
  expect(readGoals('other', '2026-10-15').lines).toEqual([]);
});

it('reads hand-edited plain/bulleted lines and separates the recap', () => {
  const file = goalsFile('g', '2026-10-15'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Today\n\nShip\n* Review\n\n## Recap\n\nAlso done: cleanup.\n');
  expect(readGoals('g', '2026-10-15')).toEqual({ grounds: 'g', date: '2026-10-15', lines: ['Ship', 'Review'], recap: 'Also done: cleanup.' });
});

it('claims the reminder once per day across sessions; goals or an existing card suppress it', () => {
  expect(claimGoalsPrompt('g', '2026-10-14')).toBe(true);
  expect(claimGoalsPrompt('g', '2026-10-14')).toBe(false);
  expect(claimGoalsPrompt('g', '2026-10-15')).toBe(true);
  expect(fs.readdirSync(path.dirname(goalsFile('g', '2026-10-15'))).sort()).toEqual(['2026-10-14.md', '2026-10-15.md']);
  setGoals('g', '2026-10-16', ['Already set']);
  expect(claimGoalsPrompt('g', '2026-10-16')).toBe(false);
  expect(claimGoalsPrompt('g', '2026-10-17', true)).toBe(false);
  expect(claimGoalsPrompt('other', '2026-10-14')).toBe(true);
});

it.each(['../escape', '2026-02-30', '2026-99-99'])('rejects invalid dates and traversal: %s', (date) => {
  expect(() => setGoals('g', date, ['x'])).toThrow('YYYY-MM-DD');
});
it('rejects empty/multiline goals and invalid grounds', () => {
  expect(() => setGoals('g', '2026-10-15', [])).toThrow('goal lines');
  expect(() => setGoals('g', '2026-10-15', ['a\nb'])).toThrow('goal lines');
  expect(() => goalsFile('../g', '2026-10-15')).toThrow('grounds');
});
