import { goalDate } from './goals.js';
import { TodoError } from './todos.js';

/**
 * Reading and printing todo times. A time is read in `[helm].timezone`, or the
 * system zone when that is unset. A day name means a goal day, which runs from
 * 04:00 to 04:00 local, so `fri 01:00` is the late end of Friday.
 */

/** The hour a bare day name means: "try again Thursday" reads as written. */
const BARE_DAY_HOUR = 9;
/** A goal day starts at this local hour (see `goalDate`). */
const GOAL_DAY_START_HOUR = 4;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DURATION = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 };
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const TWELVE_HOUR = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

/** A 24-hour clock reading. */
interface ClockTime {
  hour: number;
  minute: number;
}

/** The zone name to print: the configured one, or the system's. */
export function todoZoneName(timezone?: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
}

/** The wall-clock reading of an instant in a zone, as if it were UTC milliseconds. */
function wallClockMs(instant: number, timezone?: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (key: string) => Number(parts.find((p) => p.type === key)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function zoneOffsetMs(instant: number, timezone?: string): number {
  return wallClockMs(instant, timezone) - Math.floor(instant / 1000) * 1000;
}

/** Shift a YYYY-MM-DD day by whole days. */
export function addCalendarDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

/** The first instant at or after `from` whose zone offset differs from the offset at `from`. */
function nextOffsetChange(from: number, to: number, timezone?: string): number {
  const startOffset = zoneOffsetMs(from, timezone);
  let low = from;
  let high = to;
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2);
    if (zoneOffsetMs(middle, timezone) === startOffset) low = middle;
    else high = middle;
  }
  return high;
}

/**
 * The instant a zone's clock reads this day and time. A time skipped by a
 * spring clock change moves to the first valid moment after the gap. A time
 * repeated by an autumn change uses the first of the two.
 */
export function wallClockInstant(day: string, time: ClockTime, timezone?: string): number {
  const wanted = Date.parse(`${day}T00:00:00Z`) + (time.hour * 3600 + time.minute * 60) * 1000;
  const before = wanted - 86400_000;
  const after = wanted + 86400_000;
  const matches = [zoneOffsetMs(before, timezone), zoneOffsetMs(after, timezone)]
    .map((offset) => wanted - offset)
    .filter((instant) => wallClockMs(instant, timezone) === wanted)
    .sort((a, b) => a - b);
  return matches[0] ?? nextOffsetChange(before, after, timezone);
}

/** The instant of a time on a goal day. An hour before 04:00 is the next calendar day. */
export function goalDayInstant(goalDay: string, time: ClockTime, timezone?: string): number {
  const calendarDay = time.hour < GOAL_DAY_START_HOUR ? addCalendarDays(goalDay, 1) : goalDay;
  return wallClockInstant(calendarDay, time, timezone);
}

/** The weekday of a YYYY-MM-DD day: 0 is Sunday. */
export function calendarWeekday(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/** A clock reading from `HH:MM`, or undefined when it isn't a real 24-hour time. */
export function parseClockTime(text: string): ClockTime | undefined {
  const match = CLOCK.exec(text);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
}

/** The weekday a name or three-letter short form means, or undefined. */
export function parseWeekday(text: string): number | undefined {
  const word = text.toLowerCase();
  if (word.length < 3) return undefined;
  const index = DAY_NAMES.findIndex((name) => name === word || name.slice(0, 3) === word);
  return index < 0 ? undefined : index;
}

function refuseUnreadable(input: string): never {
  throw new TodoError(`can't read "${input}" as a time: try "fri 09:00", "tomorrow 09:00", "2026-11-06 09:00" or --in 2h`);
}

/** The refusal for a 12-hour time, naming the 24-hour form of what was typed. */
function refuseTwelveHour(input: string, match: RegExpExecArray): never {
  const twelve = Number(match[1]) % 12;
  const hour = match[3]!.toLowerCase() === 'pm' ? twelve + 12 : twelve;
  const clock = `${String(hour).padStart(2, '0')}:${match[2] ?? '00'}`;
  throw new TodoError(`use 24-hour time: "${input.replace(match[0], clock)}"`);
}

function refusePast(input: string, timezone?: string): never {
  throw new TodoError(`${input} ${todoZoneName(timezone)} has passed: give a time ahead`);
}

function checkedAhead(instant: number, input: string, now: number, timezone?: string): string {
  if (instant <= now) refusePast(input, timezone);
  return new Date(instant).toISOString();
}

/** `--in`: a duration from now, as an ISO instant. The same units as `paused --until`. */
export function parseTodoDuration(input: string, now = Date.now()): string {
  const text = input.trim();
  const match = DURATION.exec(text);
  if (!match) throw new TodoError(`can't read "${input}" as a duration: try 30m, 2h or 3d`);
  const ms = Number(match[1]) * UNIT_MS[match[2]!.toLowerCase()]!;
  if (!(ms > 0)) throw new TodoError(`${text} has passed: give a time ahead`);
  return new Date(now + ms).toISOString();
}

/**
 * `--at`: the forms a person writes for a moment ahead, as an ISO instant.
 * Throws a `TodoError` with the form to use for anything it can't read, and
 * for a time that has passed.
 */
export function parseTodoTime(input: string, now = Date.now(), timezone?: string): string {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) refuseUnreadable(input);
  if (ISO_INSTANT.test(text)) {
    const instant = Date.parse(text);
    if (!Number.isFinite(instant)) refuseUnreadable(input);
    if (instant <= now) throw new TodoError(`${text} has passed: give a time ahead`);
    return new Date(instant).toISOString();
  }
  const twelveHour = TWELVE_HOUR.exec(text);
  if (twelveHour) refuseTwelveHour(text, twelveHour);

  const words = text.split(' ');
  const first = words[0]!;
  if (words.length > 2) refuseUnreadable(input);
  const named = words.length === 2 ? parseClockTime(words[1]!) : { hour: BARE_DAY_HOUR, minute: 0 };

  if (words.length === 1) {
    const clock = parseClockTime(first);
    if (clock) {
      const today = new Date(wallClockMs(now, timezone)).toISOString().slice(0, 10);
      const reading = wallClockInstant(today, clock, timezone);
      return new Date(reading > now ? reading : wallClockInstant(addCalendarDays(today, 1), clock, timezone)).toISOString();
    }
  }
  if (!named) refuseUnreadable(input);

  if (CALENDAR_DAY.test(first) && words.length === 2) {
    if (new Date(`${first}T12:00:00Z`).toISOString().slice(0, 10) !== first) refuseUnreadable(input);
    return checkedAhead(wallClockInstant(first, named, timezone), text, now, timezone);
  }

  const goalDay = goalDate(new Date(now), timezone);
  const relative = first.toLowerCase();
  if (relative === 'today') return checkedAhead(goalDayInstant(goalDay, named, timezone), text, now, timezone);
  if (relative === 'tomorrow') return checkedAhead(goalDayInstant(addCalendarDays(goalDay, 1), named, timezone), text, now, timezone);

  const weekday = parseWeekday(first);
  if (weekday === undefined) refuseUnreadable(input);
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const day = addCalendarDays(goalDay, ahead);
    if (calendarWeekday(day) !== weekday) continue;
    const instant = goalDayInstant(day, named, timezone);
    if (instant > now) return new Date(instant).toISOString();
  }
  return refuseUnreadable(input);
}

/** `snooze --until`: a duration from now, or any form `--at` reads. */
export function parseTodoUntil(input: string, now = Date.now(), timezone?: string): string {
  return DURATION.test(input.trim()) ? parseTodoDuration(input, now) : parseTodoTime(input, now, timezone);
}

/** A due time in full, so a misread day shows at once: `Fri Nov 6, 09:00 EST`. */
export function formatTodoTime(at: string, timezone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date(at));
  const part = (key: string) => parts.find((p) => p.type === key)?.value ?? '';
  return `${part('weekday')} ${part('month')} ${part('day')}, ${part('hour')}:${part('minute')} ${part('timeZoneName')}`;
}

/** A due time for a table cell: `fri 09:00` this week, `nov 20 09:00` further out. */
export function shortTodoTime(at: string, now = Date.now(), timezone?: string): string {
  const instant = Date.parse(at);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (key: string) => parts.find((p) => p.type === key)?.value ?? '';
  const clock = `${part('hour')}:${part('minute')}`;
  const withinWeek = instant - now < 6 * 86400_000;
  return (withinWeek ? `${part('weekday')} ${clock}` : `${part('month')} ${part('day')} ${clock}`).toLowerCase();
}
