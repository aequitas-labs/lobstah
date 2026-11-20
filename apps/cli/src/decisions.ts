import { runSealKey } from './run-seal.js';
import { answeredAt, cardCoversQuestion, decisionHandoff, handoffDecisions, archivedDecisionDir, decisionDir, decisionViewedAt, listDecisions, readDecision, readDecisionDetail, readRunAttempt, readStoredRunScript, scriptWarnings, standingDecisions } from '@lobstah/core';
import type { DecisionAnswerPayload, DecisionMeta, GlassDecision, GlassRunCard, LobstahRequest, TendAttention } from '@lobstah/core';

/**
 * The CLI half of decisions (core's decisions.ts stores them): the
 * `decision` attention items, the rule that a framed decision hides the raw
 * question it frames, the glass rows, and how `man wait` and the park print
 * a `decision-answer` request.
 */

/** One `decision` attention item per standing decision: it stands until answered or withdrawn. */
export function decisionAttention(now: number, decisions: DecisionMeta[] = standingDecisions()): TendAttention[] {
  return decisions.map((d) => {
    const viewedAt = decisionViewedAt(d.key);
    return {
    kind: 'decision',
    key: d.key,
    stateHash: d.stateHash,
    id: d.dispatch ?? d.key,
    lane: d.lane ?? 'work',
    verb: 'decision',
    ageSecs: Math.max(0, Math.round((now - Date.parse(d.askedAt)) / 1000)),
    at: d.askedAt,
    standingSince: d.askedAt,
    note: d.title,
    ...(d.repo ? { repo: d.repo } : {}),
    ...(viewedAt ? { viewedAt } : {}),
    };
  });
}

/**
 * A raw `question` is hidden while a decision frames it: a decision on the
 * same dispatch for that question, or one linked from its report, that has
 * not been withdrawn. An answered one keeps hiding it until the worker reports
 * again or the helm sends the answer on.
 */
export function hideFramedQuestions(
  attention: TendAttention[],
  decisions: Array<Pick<DecisionMeta, 'dispatch' | 'lane' | 'askedAt' | 'permission' | 'permissionsProposal'> & Partial<Pick<DecisionMeta, 'key' | 'questionAt'>>> = listDecisions(),
): TendAttention[] {
  // A permission card frames nothing: it stands beside the trap's question, never in place of it.
  const frames = decisions.filter((d) => !d.permission && !d.permissionsProposal);
  return attention.filter(
    (a) =>
      a.kind !== 'question' ||
      !frames.some((d) => cardCoversQuestion(d, a.id, a.lane, { verb: a.verb === 'blocked' ? 'blocked' : 'needs-decision', at: a.at ?? '', link: a.link })),
  );
}

/**
 * A run card as the glass shows it: the stored script, read now, with the
 * characters to warn about. A copy that no longer hashes to the card's value
 * is shown as altered, and never runs.
 */
export function glassRunCard(d: DecisionMeta): GlassRunCard | undefined {
  if (!d.run) return undefined;
  const dir = readDecision(d.key) ? decisionDir(d.key) : archivedDecisionDir(d.key);
  const stored = dir ? readStoredRunScript(dir) : undefined;
  const script = stored?.text ?? '';
  return {
    ...d.run,
    latest: readRunAttempt(d.key),
    script,
    warnings: scriptWarnings(script),
    ...(stored?.sha256 !== d.run.scriptSha256 ? { altered: true } : {}),
    sealKey: runSealKey().publicKey,
  };
}

/** Standing decisions, then answered ones handed to the helm, as the glass renders them. */
export function glassDecisions(decisions: DecisionMeta[] = [...standingDecisions(), ...handoffDecisions()]): GlassDecision[] {
  return decisions.map((d) => {
    const viewedAt = decisionViewedAt(d.key);
    const handoff = decisionHandoff(d.key);
    return {
    key: d.key,
    title: d.title,
    ...(d.thread ? { thread: d.thread } : {}),
    ...(d.appStart ? { appStart: d.appStart } : {}),
    detail: readDecisionDetail(d.key) ?? '',
    options: d.options,
    ...(d.references?.length ? { references: d.references } : {}),
    ...(d.permission ? { permission: true } : {}),
    ...(d.permissionsProposal ? { permissionsProposal: d.permissionsProposal } : {}),
    ...(d.run ? { run: glassRunCard(d) } : {}),
    ...(d.optionNotes ? { optionNotes: d.optionNotes } : {}),
    attachments: d.attachments,
    ...(d.dispatch ? { dispatch: d.dispatch } : {}),
    ...(d.lane ? { lane: d.lane } : {}),
    ...(d.repo ? { repo: d.repo } : {}),
    askedBy: d.askedBy,
    askedAt: d.askedAt,
    stateHash: d.stateHash,
    ...(viewedAt ? { viewedAt } : {}),
    ...(handoff
      ? {
          handoff: {
            state: handoff.state,
            answeredAt: handoff.answer.answeredAt,
            ...(handoff.answer.option !== undefined ? { option: handoff.answer.option } : {}),
            ...(handoff.answer.text !== undefined ? { text: handoff.answer.text } : {}),
            ...(handoff.ack ? { ackedAt: handoff.ack.ackedAt, ...(handoff.ack.note ? { note: handoff.ack.note } : {}) } : {}),
          },
        }
      : {}),
    };
  });
}

/** The fields of one `decision-answer` event, in print order: the request id and its payload. */
export function decisionEventFields(r: LobstahRequest): Record<string, string> {
  const p = r.payload as unknown as DecisionAnswerPayload;
  return {
    event: 'decision-answer',
    id: r.id,
    key: p.key,
    ...(p.dispatch ? { dispatch: p.dispatch } : {}),
    title: p.title,
    ...(p.thread ? { thread: p.thread } : {}),
    option: p.option ?? '',
    text: p.text ?? '',
    ...(p.run ? { runState: p.run.state, exitCode: String(p.run.exitCode), tail: p.run.tail } : {}),
    attachments: (p.attachments ?? []).map((a) => a.path).join(', '),
    from: r.from,
    at: r.at,
    ...(decisionHandoff(p.key)?.state === 'answered' ? { next: ackNext(p.key) } : {}),
  };
}

/** What a helm does with an answer that awaits its ack. */
const ackNext = (key: string) => `act on it, then \`lobstah man ack ${key} "<what you did>"\`; until then the card spins in the glass and blocks your turn end`;

/** A `man haul` line for a decision answer. */
export function decisionLine(r: LobstahRequest): string {
  const p = r.payload as unknown as DecisionAnswerPayload;
  const decision = readDecision(p.key);
  const delivered = decision?.dispatch && decision.questionAt && answeredAt(decision.dispatch, decision.lane ?? 'work', decision.questionAt);
  const what = [
    p.option && `option "${p.option}"`,
    p.text && `text: ${p.text}`,
    p.attachments?.length > 0 && `files: ${p.attachments.map((a) => a.path).join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    `- decision-answer ${p.key}${p.dispatch ? ` (${p.dispatch})` : ''} — ${p.title} · ${what} (request ${r.id}). ` +
    (delivered
      ? 'The answer was delivered to the worker’s inbox.'
      : decisionHandoff(p.key)?.state === 'answered'
        ? `Act on it (for a dispatch, usually \`lobstah send <dispatch> --for-decision ${p.key} "<instruction>"\`), then \`lobstah man ack ${p.key} "<what you did>"\` unless the send acked it.`
        : 'Act on it; for a dispatch, usually `lobstah send <dispatch> "<instruction>"`.')
  );
}
