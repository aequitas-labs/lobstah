import { loadConfig } from './config.js';
import { storedDescriptor } from './queue.js';
import { hasOpenCatch, readTrap, trapBySession, trapIdAbove } from './soak.js';

export interface TrapSessionTitle {
  title: string;
  name: string;
  work: string | null;
}

function stripTerminalSequences(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/g, '')
    .replace(/\u001b[PX^_][\s\S]*?(?:\u001b\\|$)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[ -/]*[@-~]/g, '');
}

/** Remove terminal controls before the brief can reach a title setter. */
export function cleanTitleText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Cap by code point, preferring the last whole word in the sidebar width. */
function shortWork(value: string, limit = 40): string {
  const points = Array.from(value);
  if (points.length <= limit) return value;
  const prefix = points.slice(0, limit + 1).join('');
  const boundary = prefix.lastIndexOf(' ');
  return (boundary >= Math.floor(limit / 2) ? prefix.slice(0, boundary) : points.slice(0, limit).join('')).trimEnd();
}

export function titleFromBrief(brief: string): string {
  const first = stripTerminalSequences(brief).split(/\r\n|\r|\n/, 1)[0] ?? '';
  return shortWork(cleanTitleText(first).replace(/^#{1,6}\s*/, ''));
}

/** The title only for the caller's signed-on trap. Never reads a transcript. */
export function trapSessionTitle(input: { sessionId?: string; cwd: string }): TrapSessionTitle | undefined {
  if (loadConfig().soak.sessionTitle === false) return undefined;
  const reg = input.sessionId ? trapBySession(input.sessionId) : readTrap(trapIdAbove(input.cwd) ?? '');
  if (!reg || (input.sessionId && reg.sessionId !== input.sessionId)) return undefined;
  const name = Array.from(cleanTitleText(reg.name ?? `wt:${reg.trapId}`)).slice(0, 40).join('');
  const work = reg.claimed && hasOpenCatch(reg) ? titleFromBrief(storedDescriptor(reg.claimed, 'work')?.brief ?? '') : '';
  return { title: work ? `${name} · ${work}` : name, name, work: work || null };
}
