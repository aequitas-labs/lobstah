import { DecisionError, GrantError, answerDecision, askDecision, decisionDir, loadConfig, markDecisionViewed, markQuestionViewed, readDecision } from '@lobstah/core';
import type { AnswerSource, DecisionAnswer, DecisionMeta, DecisionUpload, Grant, Lane } from '@lobstah/core';
import * as fs from 'node:fs';
import { applyPermissionAnswer, permissionAnswerAllowed } from './grants-cli.js';
import { buildTendReport } from './tend.js';
import { currentAck, writeAck } from './acks.js';

/**
 * Answering, from the glass's `/requests` POST or `man answer`. A decision key answers
 * that decision. A raw question's key (`<lane>:<id>`, a worker's
 * needs-decision the helm has not framed) is framed first as a decision
 * asked by the worker, then answered, so the answer reaches the helm the
 * same way.
 */

export interface AnswerRequest {
  option?: string;
  text?: string;
  attach?: string[];
  uploads?: DecisionUpload[];
  /** `wharf` only from the boat's receipt applier, after its own checks (wharf-answers.ts). */
  by: AnswerSource;
  receipt?: string;
}

/** A standing, unframed question for `<lane>:<id>`, as the glass shows it. */
function standingQuestion(key: string) {
  return buildTendReport().attention.find((a) => a.kind === 'question' && a.key === key);
}

export function answerKey(key: string, req: AnswerRequest): { decision: DecisionMeta; answer: DecisionAnswer; grant?: Grant } {
  const maxBytes = loadConfig().limits.attachmentMaxBytes;
  if (key.startsWith('decision:')) {
    // A permission card: only the glass may allow. An allow writes the grant and tells the trap.
    const asked = readDecision(key);
    if (asked?.permissionsProposal) throw new DecisionError('Permissions proposals can only be answered through their dedicated glass action; CLI and ordinary decision answers cannot apply them.', 403);
    if (asked?.permission) {
      if (!req.option) throw new DecisionError('choose an option on the permission card; a text reply cannot grant permission', 400);
      try {
        permissionAnswerAllowed(asked, req.option, req.by);
      } catch (err) {
        if (err instanceof GrantError) throw new DecisionError(err.message, 403);
        throw err;
      }
    }
    const answer = answerDecision({ key, ...req, maxBytes });
    const decision = readDecision(key)!;
    const grant = decision.permission ? applyPermissionAnswer(decision, answer) : undefined;
    return { decision, answer, ...(grant ? { grant } : {}) };
  }
  const q = /^(work|chore):[A-Za-z0-9-]+$/.test(key) ? standingQuestion(key) : undefined;
  if (!q) throw new DecisionError(`no standing decision or question ${key}`, 404);
  const note = (q.note ?? q.verb).trim() || q.verb;
  const firstLine = note.split('\n')[0]!.trim();
  const title = firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine;
  const { meta } = askDecision({
    title,
    detailText: note === title ? '' : note,
    dispatch: q.id,
    lane: q.lane as Lane,
    ...(q.repo ? { repo: q.repo } : {}),
    askedBy: 'worker',
    maxBytes,
  });
  try {
    return { decision: meta, answer: answerDecision({ key: meta.key, ...req, maxBytes }) };
  } catch (err) {
    // A refused answer leaves the question as it was.
    fs.rmSync(decisionDir(meta.key)!, { recursive: true, force: true });
    throw err;
  }
}

/**
 * The human opened a decision (or a raw question) in the glass's decision
 * modal: record its first view and acknowledge its current attention. State only: it answers nothing and wakes
 * no one. A raw question's view is scoped to when it was asked.
 */
export function viewKey(key: string, now = new Date()): { key: string; viewedAt: string; first: boolean } {
  const item = buildTendReport().attention.find((a) => a.key === key && (a.kind === 'decision' || a.kind === 'question'));
  let viewed: { viewedAt: string; first: boolean };
  if (key.startsWith('decision:')) viewed = markDecisionViewed(key, now);
  else {
    if (!/^(work|chore):[A-Za-z0-9-]+$/.test(key) || !item?.at) throw new DecisionError(`no standing decision or question ${key}`, 404);
    viewed = markQuestionViewed(key, item.at, now);
  }
  if (item && !currentAck(key, item.stateHash)) writeAck({ key, kind: item.kind, stateHash: item.stateHash, at: now.toISOString(), by: 'glass' });
  return { key, ...viewed };
}
