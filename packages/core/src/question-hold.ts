import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { liveHelms } from './helm.js';
import type { HelmRegistration } from './helm.js';
import { answeredAt } from './inbox.js';
import { uniqueTempPath, lobstahHome } from './paths.js';
import { activeIds, pendingIds, storedDescriptor } from './queue.js';
import { readStatusLog } from './status.js';
import type { Lane, StatusEntry } from './types.js';

/**
 * The helm's turn on a question. While a helm is signed on for a question's
 * grounds, the question is held: it stays in the helm's own views (`man
 * tend --json`, `man wait`, the park, reminders) but not in the human's (the
 * pet's `attention --json`, the glass, notifyCommand). The first `man haul`
 * of that helm that finds the question still unanswered releases it: the
 * helm ended a turn without answering. With no live helm for the grounds
 * (none signed on, relieved, or its registration stale past
 * `[helm].ttlSecs`), nothing is held.
 *
 * A release is `releases/<key>.json`, `{ key, stateHash, releasedAt, by }`,
 * beside `acks/`. It holds only while the stateHash matches: a question
 * filed again is held again.
 */

export interface QuestionRelease {
  key: string;
  stateHash: string;
  releasedAt: string;
  /** The helm session whose turn ended. */
  by: string;
}

/** A standing question as the hold sees it. */
export interface HeldQuestion {
  key: string;
  stateHash: string;
  id: string;
  lane: Lane;
  repo?: string;
  entry: StatusEntry;
}

const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/** stateHash for question / landed: the status entry the item stands on. */
export function statusStateHash(verb: string, at: string | undefined): string {
  return sha({ verb, at: at ?? '' });
}

export function releasesDir(): string {
  return path.join(lobstahHome(), 'releases');
}

function releaseFile(key: string): string {
  return path.join(releasesDir(), `${key.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
}

export function readRelease(key: string): QuestionRelease | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(releaseFile(key), 'utf8')) as QuestionRelease;
    return r.key === key ? r : undefined;
  } catch {
    return undefined;
  }
}

/** The release for this filing of the question, if its turn has ended. */
export function currentRelease(key: string, stateHash: string): QuestionRelease | undefined {
  const r = readRelease(key);
  return r && r.stateHash === stateHash ? r : undefined;
}

function writeRelease(r: QuestionRelease): void {
  fs.mkdirSync(releasesDir(), { recursive: true });
  const file = releaseFile(r.key);
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function listReleases(): QuestionRelease[] {
  let files: string[];
  try {
    files = fs.readdirSync(releasesDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(releasesDir(), f), 'utf8')) as QuestionRelease];
    } catch {
      return [];
    }
  });
}

export function removeRelease(key: string): void {
  fs.rmSync(releaseFile(key), { force: true });
}

const covers = (helm: HelmRegistration, repo: string | undefined) => repo === undefined || helm.repos.includes(repo);

/** The live helm whose grounds cover a repo, if any. */
export function holdingHelm(repo: string | undefined, now = Date.now()): HelmRegistration | undefined {
  let ttlMs: number;
  try {
    ttlMs = loadConfig().helm.ttlSecs * 1000;
  } catch {
    return undefined; // a broken config holds nothing back from the human
  }
  return liveHelms(ttlMs, now).find((h) => covers(h, repo));
}

/** Whether a question is held on the helm's turn: a live helm covers it and has not released this filing. */
export function questionHeld(q: Pick<HeldQuestion, 'key' | 'stateHash' | 'repo'>, now = Date.now()): boolean {
  return holdingHelm(q.repo, now) !== undefined && currentRelease(q.key, q.stateHash) === undefined;
}

/** The standing question of a dispatch: its last entry is needs-decision or blocked, with no newer message. */
export function standingQuestion(id: string, lane: Lane): HeldQuestion | undefined {
  const entry = readStatusLog(id, lane).at(-1);
  if (!entry || (entry.verb !== 'needs-decision' && entry.verb !== 'blocked')) return undefined;
  if (answeredAt(id, lane, entry.at) !== undefined) return undefined;
  return {
    key: `${lane}:${id}`,
    stateHash: statusStateHash(entry.verb, entry.at),
    id,
    lane,
    repo: storedDescriptor(id, lane)?.repo,
    entry,
  };
}

/** Every standing question in the queue and in flight. */
export function standingQuestions(): HeldQuestion[] {
  const out: HeldQuestion[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) {
    for (const id of [...pendingIds(lane), ...activeIds(lane)]) {
      const q = standingQuestion(id, lane);
      if (q) out.push(q);
    }
  }
  return out;
}

/**
 * `man haul` for a helm session: the helm ended a turn. Each standing,
 * unanswered question in its grounds that is not yet released for this
 * filing is released now. Returns the new releases.
 */
export function releaseHeldQuestions(helm: HelmRegistration, now = Date.now()): QuestionRelease[] {
  const out: QuestionRelease[] = [];
  for (const q of standingQuestions()) {
    if (!covers(helm, q.repo) || currentRelease(q.key, q.stateHash)) continue;
    const r = { key: q.key, stateHash: q.stateHash, releasedAt: new Date(now).toISOString(), by: helm.sessionId };
    writeRelease(r);
    out.push(r);
  }
  return out;
}
