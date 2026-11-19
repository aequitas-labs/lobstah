import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneDirs, readDirIfPresent, uniqueTempPath, atomicRenameSync } from './paths.js';
import { questionEntry, readStatusLog } from './status.js';
import { readEvidence } from './evidence.js';
import { storedDescriptor } from './queue.js';
import { chainPr } from './chain-pr.js';
import { parsePrRef, type PrRef } from './pr.js';
import { answeredAt, commitQuestionAnswer } from './inbox.js';
import { tryDirLock, withDirLock } from './dir-lock.js';
import type { Lane } from './types.js';

/** One durable PR conversation question, independent of status/live tracker comments. */
export interface PrQuestion {
  dispatch: string;
  lane: Lane;
  number: number;
  askedAt: string;
  text: string;
  pr: PrRef;
  /** Inline discussion anchors carried by the dispatch's originating feedback brief. */
  reviewThreadIds: number[];
  commentId?: number;
  commentUrl?: string;
  answeredAt?: string;
  /** The answer acknowledgement was successfully written back to GitHub. */
  answerMarkedAt?: string;
  /** Events consumed as answers are permanently excluded from feedback rounds. */
  replies: string[];
}

/** Common fields from GitHub conversation comments and inline review replies. */
export interface PrQuestionReply {
  id: number;
  body: string;
  created_at: string;
  html_url?: string;
  user: { login: string; type?: string };
  in_reply_to_id?: number;
}

/** GitHub effects are injected; fixtures never read tokens or contact GitHub. */
export interface PrQuestionTransport {
  identity: string;
  comments(pr: PrRef): Promise<PrQuestionReply[]>;
  reviewComments(pr: PrRef): Promise<PrQuestionReply[]>;
  post(pr: PrRef, body: string): Promise<{ id: number; html_url?: string }>;
  edit(pr: PrRef, commentId: number, body: string): Promise<void>;
}

const questionFile = (id: string, lane: Lane): string => path.join(laneDirs(lane).state, `${id}.pr-questions.json`);

/** Stable marker survives retries and recovery after an ambiguous GitHub write. */
export function prQuestionMarker(question: Pick<PrQuestion, 'dispatch' | 'number'>): string {
  return `<!-- lobstah:question ${question.dispatch} ${question.number} -->`;
}

function readQuestions(id: string, lane: Lane): PrQuestion[] {
  try { return JSON.parse(fs.readFileSync(questionFile(id, lane), 'utf8')) as PrQuestion[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

/** Merge one record under a short local lock, preserving concurrent answer receipts. */
function saveQuestion(question: PrQuestion): void {
  const file = questionFile(question.dispatch, question.lane);
  withDirLock(`${file}.write-lock`, () => {
    const records = readQuestions(question.dispatch, question.lane);
    const index = records.findIndex((item) => item.number === question.number);
    const prior = records[index];
    const merged = { ...prior, ...question, replies: [...new Set([...(prior?.replies ?? []), ...question.replies])] };
    if (index < 0) records.push(merged); else records[index] = merged;
    const temporary = uniqueTempPath(file);
    fs.writeFileSync(temporary, JSON.stringify(records)); atomicRenameSync(temporary, file);
  }, { staleMs: 30_000, waitMs: 1000, busy: () => new Error('Question records are busy; retry.') });
}

/** Discover PR ownership from an explicit target, recorded evidence, or a feedback origin chain. */
export function dispatchQuestionPr(id: string, lane: Lane): PrRef | undefined {
  const descriptor = storedDescriptor(id, lane);
  const evidence = readEvidence(id, lane);
  const url = descriptor?.pr?.url ?? evidence.prUrl ?? evidence.pr?.url ?? chainPr(id, lane)?.url;
  return url ? parsePrRef(url) : undefined;
}

/** Snapshot new question entries once their dispatch is tied to a PR. Permission cards remain private. */
export function capturePrQuestions(id: string, lane: Lane, target?: PrRef): PrQuestion[] {
  const records = readQuestions(id, lane);
  const log = readStatusLog(id, lane);
  const standing = questionEntry(log);
  const entries = log.filter((entry) => entry.verb === 'needs-decision' && !entry.permissionRequest);
  if (standing?.verb !== 'needs-decision') return records;
  const pr = target ?? dispatchQuestionPr(id, lane);
  if (!pr) return records;
  const descriptor = storedDescriptor(id, lane);
  const briefThreadIds = [...new Set([...((descriptor?.brief ?? '').matchAll(/#discussion_r(\d+)/g))].map((match) => Number(match[1])))];
  entries.forEach((entry, index) => {
    if (entry !== standing) return;
    if (records.some((question) => question.number === index + 1)) return;
    const explicitThreads = [...new Set([...(entry.note ?? '').matchAll(/#discussion_r(\d+)/g)].map((match) => Number(match[1])))];
    const threadIds = explicitThreads.length ? explicitThreads : descriptor?.pr?.reviewThreadId ? [descriptor.pr.reviewThreadId] : briefThreadIds.length === 1 ? briefThreadIds : [];
    const question: PrQuestion = { dispatch: id, lane, number: index + 1, askedAt: entry.at, text: entry.note ?? 'A decision is needed.', pr, reviewThreadIds: threadIds, replies: [] };
    saveQuestion(question); records.push(question);
  });
  return records;
}

/** Every recorded question, including answered questions whose old replies must never wake a round. */
export function listPrQuestions(pr?: PrRef): PrQuestion[] {
  const questions: PrQuestion[] = [];
  for (const lane of ['work', 'chore'] as Lane[]) for (const name of readDirIfPresent(laneDirs(lane).state)) {
    if (!name.endsWith('.pr-questions.json')) continue;
    const records = readQuestions(name.slice(0, -'.pr-questions.json'.length), lane);
    questions.push(...records.filter((question) => !pr || question.pr.key === pr.key));
  }
  return questions;
}

/** Visible copy stays separate from the hidden dispatch/question identity. */
export function prQuestionBody(question: PrQuestion, answerAt?: string): string {
  return `${prQuestionMarker(question)}\nQuestion from lobstah (${question.dispatch}, question ${question.number}):\n\n${question.text}\n\n` +
    (answerAt ? `Answered in lobstah at ${answerAt}.` : 'Reply by quoting this question or linking to this comment. You can also answer in glass.') + '\n\n<!-- lobstah -->';
}

function questionReference(question: PrQuestion, reply: PrQuestionReply, kind: 'conversation' | 'review'): number {
  if (Date.parse(reply.created_at) < Date.parse(question.askedAt)) return 0;
  if (reply.id === question.commentId && kind === 'conversation') return 0;
  if (question.commentId && reply.body.includes(`#issuecomment-${question.commentId}`)) return 3;
  if (reply.body.includes(prQuestionMarker(question))) return 3;
  if (kind === 'review' && reply.in_reply_to_id !== undefined && question.reviewThreadIds.includes(reply.in_reply_to_id)) return 2;
  const quote = reply.body.split('\n').filter((line) => /^\s*>/.test(line)).map((line) => line.replace(/^\s*>\s?/, '')).join('\n').trim();
  const quoted = (question.text.trim().length > 0 && quote.includes(question.text.trim())) ||
    quote.includes(`(${question.dispatch}, question ${question.number})`) ||
    quote.split('\n').some((line) => line.length >= 20 && question.text.includes(line));
  return quoted ? 1 : 0;
}

/** Route before feedback selection. Bots, own-identity replies and losing answers create no round. */
export function routePrQuestionReply(pr: PrRef, reply: PrQuestionReply, identity: string, kind: 'conversation' | 'review' = 'conversation'): boolean {
  const tag = `${kind === 'review' ? 'rc' : 'ic'}${reply.id}`;
  const questions = listPrQuestions(pr);
  if (questions.some((question) => question.replies.includes(tag))) return true;
  const references = questions.map((question) => ({ question, specificity: questionReference(question, reply, kind) })).filter((reference) => reference.specificity > 0);
  const specificity = Math.max(...references.map((reference) => reference.specificity));
  const candidates = references.filter((reference) => reference.specificity === specificity).map((reference) => reference.question).sort((left, right) => right.askedAt.localeCompare(left.askedAt));
  const question = candidates.find((item) => !answeredAt(item.dispatch, item.lane, item.askedAt)) ?? candidates[0];
  if (!question) return false;
  if (reply.user.type === 'Bot' || /\[bot\]$/i.test(reply.user.login) || reply.user.login.toLowerCase() === identity.toLowerCase()) return true;
  if (!reply.body.trim()) return true;
  commitQuestionAnswer(question.dispatch, question.lane, question.askedAt, () => ({ value: undefined, from: `github:${reply.user.login}`, text: `Answer from ${reply.user.login} on ${reply.html_url ?? pr.url}:\n\n${reply.body}` }));
  question.replies.push(tag);
  question.answeredAt = answeredAt(question.dispatch, question.lane, question.askedAt);
  saveQuestion(question);
  return true;
}

/** Post each question once, route human replies, and mark the PR side answered after any surface wins. */
export async function syncDispatchPrQuestions(id: string, lane: Lane, transport: PrQuestionTransport, target?: PrRef): Promise<void> {
  const questions = capturePrQuestions(id, lane, target);
  if (!questions.length) return;
  const lock = tryDirLock(`${questionFile(id, lane)}.post-lock`, { staleMs: 30_000 });
  if (!lock) return;
  try {
    const byPr = new Map(questions.map((question) => [question.pr.key, question.pr]));
    for (const pr of byPr.values()) {
      const comments = await transport.comments(pr);
      const reviewComments = await transport.reviewComments(pr);
      for (const question of readQuestions(id, lane).filter((item) => item.pr.key === pr.key)) {
        if (!question.commentId) {
          const found = comments.find((comment) => comment.body.includes(prQuestionMarker(question)) && comment.user.login.toLowerCase() === transport.identity.toLowerCase());
          const posted = found ?? await transport.post(pr, prQuestionBody(question));
          question.commentId = posted.id; question.commentUrl = posted.html_url; saveQuestion(question);
        }
      }
      const replies = [...comments.map((reply) => ({ reply, kind: 'conversation' as const })), ...reviewComments.map((reply) => ({ reply, kind: 'review' as const }))]
        .sort((left, right) => left.reply.created_at.localeCompare(right.reply.created_at) || left.reply.id - right.reply.id);
      for (const { reply, kind } of replies) routePrQuestionReply(pr, reply, transport.identity, kind);
      for (const question of readQuestions(id, lane).filter((item) => item.pr.key === pr.key)) {
        const answerAt = answeredAt(id, lane, question.askedAt);
        if (answerAt && question.commentId && !question.answerMarkedAt) {
          await transport.edit(pr, question.commentId, prQuestionBody(question, answerAt));
          question.answeredAt = answerAt; question.answerMarkedAt = answerAt; saveQuestion(question);
        }
      }
    }
  } finally { lock.release(); }
}
