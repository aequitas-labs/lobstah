import fs from 'node:fs';
import path from 'node:path';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { goalLine } from './goal-line.js';

export interface DailyGoals { grounds: string; date: string; lines: string[]; recap: string }

export function goalDate(date = new Date(), timezone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (key: string) => parts.find((p) => p.type === key)!.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  return Number(part('hour')) < 4 ? previousGoalDate(day) : day;
}
export function validGoalDate(date: string): string {
  const time = Date.parse(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new Error('date must be a real YYYY-MM-DD');
  return date;
}
export function previousGoalDate(date: string): string {
  return new Date(Date.parse(`${validGoalDate(date)}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
}
export function goalsFile(grounds: string, date: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(grounds)) throw new Error('invalid grounds name');
  return path.join(lobstahHome(), 'goals', grounds, `${validGoalDate(date)}.md`);
}
export function readGoals(grounds: string, date: string): DailyGoals {
  const file = goalsFile(grounds, date);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const [goals, ...recap] = text.split(/^## Recap\s*$/m);
  const lines = (goals ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && !s.startsWith('<!--')).map((s) => s.replace(/^(?:[-*]|\d+\.)\s+/, ''));
  return { grounds, date, lines, recap: recap.join('## Recap').trim() };
}
function writeGoals(day: DailyGoals): void {
  const file = goalsFile(day.grounds, day.date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, `# Goals for ${day.date}\n\n${day.lines.map((s) => `- ${s}`).join('\n')}\n${day.recap ? `\n## Recap\n\n${day.recap}\n` : ''}`);
  atomicRenameSync(tmp, file);
}
export function setGoals(grounds: string, date: string, lines: string[]): DailyGoals {
  if (!lines.length || lines.some((s) => !s.trim() || /[\r\n]/.test(s))) throw new Error('give one or more nonempty goal lines');
  const day = { ...readGoals(grounds, date), lines: lines.map((s) => s.trim()) };
  writeGoals(day); return day;
}
export function setGoalsRecap(grounds: string, date: string, recap: string): DailyGoals {
  recap = recap.trim().replace(/^## Recap(?:\r?\n|$)\s*/, '');
  if (!recap.trim()) throw new Error('recap file is empty');
  const day = { ...readGoals(grounds, date), recap: recap.trim() };
  writeGoals(day); return day;
}
export function addGoal(grounds: string, date: string, line: string): DailyGoals {
  return setGoals(grounds, date, [...readGoals(grounds, date).lines, line]);
}
export function removeGoal(grounds: string, date: string, number: number): DailyGoals {
  const day = readGoals(grounds, date);
  if (!Number.isSafeInteger(number) || number < 1 || number > day.lines.length) throw new Error('goal number must be a line shown by lobstah goals');
  day.lines.splice(number - 1, 1);
  writeGoals(day); return day;
}
export function setGoalDone(grounds: string, date: string, number: number, done: boolean): DailyGoals {
  const day = readGoals(grounds, date);
  if (!Number.isSafeInteger(number) || number < 1 || number > day.lines.length) throw new Error('goal number must be a line shown by lobstah goals');
  day.lines[number - 1] = `[${done ? 'x' : ' '}] ${goalLine(day.lines[number - 1]!).text}`;
  writeGoals(day); return day;
}
export const goalsCardTitle = (date: string) => `Goals for ${validGoalDate(date)}`;

/** One prompt per grounds/day, not per session: restarts must not ask again. */
export function claimGoalsPrompt(grounds: string, date: string, cardExists = false): boolean {
  if (readGoals(grounds, date).lines.length || cardExists) return false;
  const file = goalsFile(grounds, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The daily file is also the once-only claim: no second daily state file.
  try { fs.writeFileSync(file, `# Goals for ${date}\n\n<!-- First-chat goals reminder delivered. Fill in today's goal lines here. -->\n`, { flag: 'wx' }); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
}
