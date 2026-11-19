import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneDirs, uniqueTempPath, atomicRenameSync } from './paths.js';
import { activeIds } from './queue.js';
import { loadConfig } from './config.js';
import { personWaiting, readStatusLog, appendStatus } from './status.js';
import { answeredAt } from './inbox.js';
import { heartbeatTrap, hasOpenCatch, readSessionClaim, readTrap, restoreTrapCatch } from './soak.js';
import { ageLabel } from './activity.js';
import type { Lane, StatusEntry } from './types.js';

/** A resumable question park retains the question verb and its attention card. */
export interface QuestionPark {
  questionAt: string;
  parkedAt: string;
  note: string;
}

const parkFile = (id: string, lane: Lane): string => path.join(laneDirs(lane).state, `${id}.question-park.json`);

/** Only the exact question that was parked owns this record; a newer report supersedes it. */
export function questionPark(id: string, lane: Lane, entry = readStatusLog(id, lane).at(-1)): QuestionPark | undefined {
  if (!entry || (entry.verb !== 'needs-decision' && entry.verb !== 'blocked')) return undefined;
  try {
    const parked = JSON.parse(fs.readFileSync(parkFile(id, lane), 'utf8')) as QuestionPark;
    return parked.questionAt === entry.at && typeof parked.parkedAt === 'string' ? parked : undefined;
  } catch { return undefined; }
}

/** Whether the current unanswered question has reached its independent person-wait limit. */
export function questionWaitExpired(id: string, lane: Lane, waitSecs: number, now = Date.now()): boolean {
  const entry = readStatusLog(id, lane).at(-1);
  return !!entry && personWaiting(id, lane, entry) && now - Date.parse(entry.at) >= waitSecs * 1000;
}

/** Park without replacing the question, failing the dispatch, or changing its resumable session. */
export function parkQuestion(id: string, lane: Lane, waitSecs: number, now = Date.now()): QuestionPark | undefined {
  const entry = readStatusLog(id, lane).at(-1);
  if (!entry || !questionWaitExpired(id, lane, waitSecs, now)) return undefined;
  const prior = questionPark(id, lane, entry);
  if (prior) return prior;
  const duration = waitSecs >= 3600 && waitSecs % 3600 === 0 ? `${waitSecs / 3600}h` : ageLabel(waitSecs * 1000);
  const parked: QuestionPark = { questionAt: entry.at, parkedAt: new Date(now).toISOString(), note: `parked: no answer in ${duration}` };
  const target = parkFile(id, lane);
  const temporary = uniqueTempPath(target);
  fs.writeFileSync(temporary, JSON.stringify(parked));
  atomicRenameSync(temporary, target);
  return parked;
}

/** Free a trap's claim after a person wait expires; a late answer reacquires it when the trap is free. */
export function reconcileTrapQuestions(now = Date.now(), waitSecs = loadConfig().limits.questionWaitSecs ?? 86400): void {
  for (const lane of ['work', 'chore'] as Lane[]) for (const id of activeIds(lane)) {
    const claim = readSessionClaim(id, lane);
    if (!claim?.by.startsWith('wt:')) continue;
    const trap = readTrap(claim.by.slice(3));
    let parked = questionPark(id, lane);
    if (!trap) {
      if (parked && answeredAt(id, lane, parked.questionAt)) restoreTrapCatch(id, lane, claim.by.slice(3), `The parked question was answered. Resume dispatch ${id} and read its inbox before continuing.`);
      continue;
    }
    if (!parked && trap.claimed === id) {
      parked = parkQuestion(id, lane, waitSecs, now);
      if (parked) heartbeatTrap(trap.trapId, { claimed: null });
    }
    if (!parked || !answeredAt(id, lane, parked.questionAt) || hasOpenCatch(readTrap(trap.trapId) ?? trap)) continue;
    appendStatus(id, lane, 'working', 'answer received; resuming parked question');
    heartbeatTrap(trap.trapId, { claimed: id });
  }
}

/** A parked question's visible note; the original question text remains available to the worker. */
export function questionParkNote(id: string, lane: Lane, entry?: StatusEntry): string | undefined {
  const parked = questionPark(id, lane, entry);
  return parked ? [parked.note, entry?.note].filter(Boolean).join(' · ') : undefined;
}
