import { DecisionError, answerDecision, askDecision, decisionDir, loadConfig, readDecision } from '@lobstah/core';
import type { DecisionAnswer, DecisionMeta, DecisionUpload, Lane } from '@lobstah/core';
import * as fs from 'node:fs';
import { buildTendReport } from './tend.js';

/**
 * Answering, from the glass's POST or `man answer`. A decision key answers
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
  by: string;
}

/** A standing, unframed question for `<lane>:<id>`, as the glass shows it. */
function standingQuestion(key: string) {
  return buildTendReport().attention.find((a) => a.kind === 'question' && a.key === key);
}

export function answerKey(key: string, req: AnswerRequest): { decision: DecisionMeta; answer: DecisionAnswer } {
  const maxBytes = loadConfig().limits.attachmentMaxBytes;
  if (key.startsWith('decision:')) {
    const answer = answerDecision({ key, ...req, maxBytes });
    return { decision: readDecision(key)!, answer };
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
    replace: false,
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
