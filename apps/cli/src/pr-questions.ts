import { execFile } from 'node:child_process';
import { activeIds, capturePrQuestions, listPrQuestions, syncDispatchPrQuestions } from '@lobstah/core';
import type { Lane, PrQuestionReply, PrQuestionTransport, PrRef } from '@lobstah/core';
import { githubViewer } from './pr-ownership.js';


/** Bounded GitHub API calls; question bodies go on stdin, never through a shell. */
async function api<T>(endpoint: string, method = 'GET', body?: string): Promise<T> {
  const args = ['api', endpoint, '--method', method];
  if (body !== undefined) args.push('--input', '-');
  return new Promise<T>((resolve, reject) => {
    const child = execFile('gh', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else { try { resolve(stdout.trim() ? JSON.parse(stdout) as T : undefined as T); } catch (parseError) { reject(parseError); } }
    });
    child.stdin?.on('error', () => {}); // execFile's callback reports an early exit or missing gh.
    if (body !== undefined) child.stdin!.end(JSON.stringify({ body }));
    else child.stdin!.end();
  });
}

/** Page both comment collections: an answer may arrive after hundreds of earlier comments. */
async function comments(endpoint: string): Promise<PrQuestionReply[]> {
  const rows: PrQuestionReply[] = [];
  for (let page = 1; ; page++) {
    const batch = await api<PrQuestionReply[]>(`${endpoint}?per_page=100&page=${page}`);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
}

/** The CLI's transport is also used by the daemon when pickup is disabled. */
export function githubQuestionTransport(identity = githubViewer()): PrQuestionTransport | undefined {
  if (!identity) return undefined;
  const repo = (pr: PrRef) => `repos/${pr.owner}/${pr.repo}`;
  return {
    identity,
    comments: (pr) => comments(`${repo(pr)}/issues/${pr.number}/comments`),
    reviewComments: (pr) => comments(`${repo(pr)}/pulls/${pr.number}/comments`),
    post: (pr, body) => api(`${repo(pr)}/issues/${pr.number}/comments`, 'POST', body),
    edit: (pr, id, body) => api(`${repo(pr)}/issues/comments/${id}`, 'PATCH', body),
  };
}

/** A report posts immediately when possible; the daemon retries failures without losing the question. */
export async function publishDispatchQuestions(id: string, lane: Lane): Promise<void> {
  if (!capturePrQuestions(id, lane).length) return;
  const transport = githubQuestionTransport();
  if (transport) await syncDispatchPrQuestions(id, lane, transport);
}

/** Nonblocking daemon pass: polls answers even when no pickup source owns the PR. */
export function createPrQuestionWatch(everyMs = 45_000): (now: number, log: (message: string) => void) => void {
  let last = -Infinity;
  let running = false;
  return (now, log) => {
    if (running || now - last < everyMs) return;
    for (const lane of ['work', 'chore'] as Lane[]) for (const id of activeIds(lane)) capturePrQuestions(id, lane);
    const questions = listPrQuestions().filter((question) => !question.answerMarkedAt);
    if (!questions.length) return;
    const transport = githubQuestionTransport();
    if (!transport) return;
    running = true; last = now;
    const dispatches = new Map(questions.map((question) => [`${question.lane}:${question.dispatch}`, question]));
    void (async () => {
      for (const question of dispatches.values()) {
        try { await syncDispatchPrQuestions(question.dispatch, question.lane, transport); }
        catch (error) { log(`PR question ${question.dispatch}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    })().catch((error: unknown) => log(`PR questions: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  };
}
