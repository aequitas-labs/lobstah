import { describe, expect, it } from 'vitest';
import { formatTodoTime, parseTodoDuration, parseTodoTime, parseTodoUntil, shortTodoTime, wallClockInstant } from '../src/todo-time.js';

const NY = 'America/New_York';
/** Thursday 2026-11-05 10:00 in New York. */
const THU_10AM = Date.parse('2026-11-05T15:00:00Z');
const at = (input: string, now = THU_10AM, tz = NY) => parseTodoTime(input, now, tz);

describe('todo times: the forms --at reads', () => {
  it('a clock time is the next time the clock reads that', () => {
    expect(at('17:00')).toBe('2026-11-05T22:00:00.000Z');
    expect(at('09:00')).toBe('2026-11-06T14:00:00.000Z');
  });

  it('today and tomorrow are goal days', () => {
    expect(at('today 17:00')).toBe('2026-11-05T22:00:00.000Z');
    expect(at('tomorrow 09:00')).toBe('2026-11-06T14:00:00.000Z');
  });

  it('a day name is the next such goal day still ahead, in short or long form', () => {
    expect(at('fri 09:00')).toBe('2026-11-06T14:00:00.000Z');
    expect(at('friday 09:00')).toBe('2026-11-06T14:00:00.000Z');
    expect(at('FRI 09:00')).toBe('2026-11-06T14:00:00.000Z');
    // Thursday at 10:00: 11:00 today is ahead, 09:00 today is next week.
    expect(at('thu 11:00')).toBe('2026-11-05T16:00:00.000Z');
    expect(at('thu 09:00')).toBe('2026-11-12T14:00:00.000Z');
  });

  it.each([
    ['sun', '2026-11-08'],
    ['mon', '2026-11-09'],
    ['tue', '2026-11-10'],
    ['wed', '2026-11-11'],
    ['thu', '2026-11-05'],
    ['fri', '2026-11-06'],
    ['sat', '2026-11-07'],
  ])('%s at 12:00 lands on %s', (name, day) => {
    expect(new Date(at(`${name} 12:00`)).toLocaleDateString('en-CA', { timeZone: NY })).toBe(day);
  });

  it('a bare day means 09:00 that day', () => {
    expect(at('fri')).toBe('2026-11-06T14:00:00.000Z');
    expect(at('tomorrow')).toBe('2026-11-06T14:00:00.000Z');
  });

  it('a date is that wall-clock time in the zone; an ISO instant is that instant', () => {
    expect(at('2026-11-06 09:00')).toBe('2026-11-06T14:00:00.000Z');
    expect(at('2026-11-06T14:00Z')).toBe('2026-11-06T14:00:00.000Z');
    expect(at('2026-11-06T09:00-05:00')).toBe('2026-11-06T14:00:00.000Z');
  });

  it('reads the helm timezone, not the machine zone', () => {
    expect(at('fri 09:00', THU_10AM, 'Asia/Tokyo')).toBe('2026-11-06T00:00:00.000Z');
  });
});

describe('todo times: the 04:00 boundary', () => {
  /** Saturday 2026-11-07 01:00 in New York: still Friday's goal day. */
  const SAT_1AM = Date.parse('2026-11-07T06:00:00Z');

  it('tomorrow at 01:00 Saturday is Saturday, because it is still Friday’s goal day', () => {
    expect(at('tomorrow 09:00', SAT_1AM)).toBe('2026-11-07T14:00:00.000Z');
  });

  it('an hour before 04:00 is the late end of the goal day it names', () => {
    expect(at('fri 01:00')).toBe('2026-11-07T06:00:00.000Z');
  });

  it('today still means the goal day in the small hours', () => {
    expect(at('today 02:00', SAT_1AM)).toBe('2026-11-07T07:00:00.000Z');
  });
});

describe('todo times: clock changes in New York', () => {
  it('2027-03-14: a time in the spring gap moves to the first valid moment after it', () => {
    expect(new Date(wallClockInstant('2027-03-14', { hour: 2, minute: 30 }, NY)).toISOString()).toBe('2027-03-14T07:00:00.000Z');
  });

  it('2027-03-14: times either side of the gap keep their wall clock', () => {
    expect(new Date(wallClockInstant('2027-03-14', { hour: 1, minute: 59 }, NY)).toISOString()).toBe('2027-03-14T06:59:00.000Z');
    expect(new Date(wallClockInstant('2027-03-14', { hour: 3, minute: 0 }, NY)).toISOString()).toBe('2027-03-14T07:00:00.000Z');
    expect(new Date(wallClockInstant('2027-03-14', { hour: 9, minute: 0 }, NY)).toISOString()).toBe('2027-03-14T13:00:00.000Z');
  });

  it('2026-11-01: a repeated autumn time uses the first of the two', () => {
    expect(new Date(wallClockInstant('2026-11-01', { hour: 1, minute: 30 }, NY)).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('2026-11-01: 09:00 either side of the change keeps its wall clock', () => {
    expect(new Date(wallClockInstant('2026-10-31', { hour: 9, minute: 0 }, NY)).toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(new Date(wallClockInstant('2026-11-01', { hour: 9, minute: 0 }, NY)).toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });
});

describe('todo times: refusals name the form to use', () => {
  it('unreadable', () => {
    expect(() => at('next week')).toThrow(`can't read "next week" as a time: try "fri 09:00", "tomorrow 09:00", "2026-11-06 09:00" or --in 2h`);
    for (const input of ['', '25:00', '09:75', 'fri 25:00', '2026-02-30 09:00', 'fri 09:00 sharp', 'fr 09:00']) {
      expect(() => at(input), input).toThrow(/can't read/);
    }
  });

  it('past', () => {
    expect(() => at('2026-01-01 09:00')).toThrow('2026-01-01 09:00 America/New_York has passed: give a time ahead');
    expect(() => at('today 09:00')).toThrow('today 09:00 America/New_York has passed: give a time ahead');
    expect(() => at('2026-01-01T09:00Z')).toThrow('2026-01-01T09:00Z has passed: give a time ahead');
  });

  it('12-hour', () => {
    expect(() => at('fri 9am')).toThrow('use 24-hour time: "fri 09:00"');
    expect(() => at('fri 9pm')).toThrow('use 24-hour time: "fri 21:00"');
    expect(() => at('12am')).toThrow('use 24-hour time: "00:00"');
    expect(() => at('12:30pm')).toThrow('use 24-hour time: "12:30"');
  });
});

describe('todo times: durations', () => {
  it('reads the same units as paused --until', () => {
    expect(parseTodoDuration('30m', THU_10AM)).toBe(new Date(THU_10AM + 1800_000).toISOString());
    expect(parseTodoDuration('2h', THU_10AM)).toBe(new Date(THU_10AM + 7200_000).toISOString());
    expect(parseTodoDuration('3d', THU_10AM)).toBe(new Date(THU_10AM + 3 * 86400_000).toISOString());
  });

  it('refuses anything else, and a zero', () => {
    expect(() => parseTodoDuration('fri', THU_10AM)).toThrow(`can't read "fri" as a duration: try 30m, 2h or 3d`);
    expect(() => parseTodoDuration('0m', THU_10AM)).toThrow('has passed');
  });

  it('--until takes a duration or a time', () => {
    expect(parseTodoUntil('2h', THU_10AM, NY)).toBe(new Date(THU_10AM + 7200_000).toISOString());
    expect(parseTodoUntil('fri 09:00', THU_10AM, NY)).toBe('2026-11-06T14:00:00.000Z');
  });
});

describe('todo times: printing', () => {
  it('prints in full so a misread day shows at once', () => {
    expect(formatTodoTime('2026-11-06T14:00:00.000Z', NY)).toBe('Fri Nov 6, 09:00 EST');
  });

  it('a table cell names the day this week and the date further out', () => {
    expect(shortTodoTime('2026-11-06T14:00:00.000Z', THU_10AM, NY)).toBe('fri 09:00');
    expect(shortTodoTime('2026-11-20T14:00:00.000Z', THU_10AM, NY)).toBe('nov 20 09:00');
  });
});
