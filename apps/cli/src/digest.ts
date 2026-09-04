import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneDirs, lobstahHome, readEvidence, readStatusLog, toonKV, toonTable, TERMINAL_VERBS } from '@lobstah/core';
import type { Descriptor, Lane } from '@lobstah/core';
import { buildTendReport } from './tend.js';
import type { TendReport } from './tend.js';

/** Never report further back than this, cursor or no cursor. */
const LOOKBACK_MS = 24 * 3600_000;

export interface DigestLanding {
  id: string;
  lane: Lane;
  verb: string;
  at: string;
  repo?: string;
  note?: string;
  prUrl?: string;
}

export interface DigestAttention {
  id: string;
  verb: string;
  ageSecs: number;
  at?: string;
  note?: string;
}

/**
 * The delta since the last report, plus the standing picture: what landed
 * (terminal catches), what arose (new attention), what still waits, and the
 * fleet verdict. `changed` is true only when the delta is non-empty — the
 * carriers (man report, man wait's timeout, the haul throttle) use it to
 * stay silent when there is nothing new to say.
 */
export interface Digest {
  since: string;
  now: string;
  changed: boolean;
  landed: DigestLanding[];
  arisen: DigestAttention[];
  standing: DigestAttention[];
  verdict: TendReport['verdict'];
  counts: TendReport['counts'];
}

function cursorFile(name: string): string {
  return path.join(lobstahHome(), 'reported', `${name}.json`);
}

function readCursor(name: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorFile(name), 'utf8')) as { through?: string };
    return typeof parsed.through === 'string' ? parsed.through : undefined;
  } catch {
    return undefined;
  }
}

/** Mark everything through `through` as reported. */
export function advanceCursor(name: string, through: string): void {
  const file = cursorFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ through })}\n`);
}

/** When the last digest was delivered (cursor mtime), for throttle cadence. */
export function lastReportedAt(name: string): number | undefined {
  try {
    return fs.statSync(cursorFile(name)).mtimeMs;
  } catch {
    return undefined;
  }
}

function doneIds(lane: Lane): string[] {
  try {
    return fs.readdirSync(laneDirs(lane).done).filter((f) => !f.startsWith('.'));
  } catch {
    return [];
  }
}

function repoOf(id: string, lane: Lane): string | undefined {
  const dirs = laneDirs(lane);
  for (const file of [
    path.join(dirs.done, id, 'descriptor.json'),
    path.join(dirs.active, id, 'descriptor.json'),
    path.join(dirs.queue, `${id}.json`),
  ]) {
    try {
      return (JSON.parse(fs.readFileSync(file, 'utf8')) as Descriptor).repo;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export interface DigestOptions {
  /** Cursor name; each grounds keeps its own. Default: the whole fleet. */
  cursor?: string;
  now?: number;
}

export function buildDigest(opts: DigestOptions = {}): Digest {
  const now = opts.now ?? Date.now();
  const name = opts.cursor ?? 'fleet';
  const cursor = readCursor(name);
  const sinceMs = Math.max(cursor ? Date.parse(cursor) || 0 : 0, now - LOOKBACK_MS);
  const since = new Date(sinceMs).toISOString();

  const landed: DigestLanding[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of doneIds(lane)) {
      const last = readStatusLog(id, lane).at(-1);
      if (!last || !TERMINAL_VERBS.includes(last.verb)) continue;
      const at = Date.parse(last.at) || 0;
      if (at <= sinceMs || at > now) continue;
      landed.push({
        id,
        lane,
        verb: last.verb,
        at: last.at,
        repo: repoOf(id, lane),
        note: last.note,
        prUrl: readEvidence(id, lane).prUrl,
      });
    }
  }
  landed.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const tend = buildTendReport(now);
  const standing: DigestAttention[] = tend.attention.map((a) => ({
    id: a.id,
    verb: a.verb,
    ageSecs: a.ageSecs,
    at: a.at,
    note: a.note,
  }));
  const arisen = standing.filter((a) => a.at !== undefined && (Date.parse(a.at) || 0) > sinceMs);

  return {
    since,
    now: new Date(now).toISOString(),
    changed: landed.length > 0 || arisen.length > 0,
    landed,
    arisen,
    standing,
    verdict: tend.verdict,
    counts: tend.counts,
  };
}

export function renderDigest(d: Digest): string {
  const lines: string[] = [toonKV({ digest: `${d.since} -> ${d.now}` })];
  if (d.landed.length > 0) {
    lines.push(
      toonTable(
        'landed',
        d.landed.map((l) => ({
          id: l.id.slice(0, 8),
          verb: l.verb,
          repo: l.repo ?? '',
          note: l.note ?? '',
          pr: l.prUrl ?? '',
        })),
        ['id', 'verb', 'repo', 'note', 'pr'],
      ),
    );
  }
  if (d.arisen.length > 0) {
    lines.push(
      toonTable(
        'arisen',
        d.arisen.map((a) => ({ id: a.id.slice(0, 8), verb: a.verb, note: a.note ?? '' })),
        ['id', 'verb', 'note'],
      ),
    );
  }
  const quiet = d.standing.filter((s) => !d.arisen.includes(s));
  if (quiet.length > 0) {
    lines.push(
      toonTable(
        'still-waiting',
        quiet.map((s) => ({ id: s.id.slice(0, 8), verb: s.verb, waitingMins: Math.round(s.ageSecs / 60), note: s.note ?? '' })),
        ['id', 'verb', 'waitingMins', 'note'],
      ),
    );
  }
  lines.push(
    toonKV({
      fleet: `${d.verdict} (${d.counts.queued} queued, ${d.counts.active} active, ${d.counts.done24h} done / ${d.counts.failed24h} failed in 24h)`,
    }),
  );
  return lines.join('\n');
}
