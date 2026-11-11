import { archivedDecisionDir, decisionDir, decisionViewedAt, listDecisions, readDecision, readDecisionDetail, readRunAttempt, readStoredRunScript, scriptWarnings, standingDecisions } from '@lobstah/core';
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
 * same dispatch, asked at or after the question, that has not been
 * withdrawn. An answered one keeps hiding it until the worker reports
 * again or the helm sends the answer on.
 */
export function hideFramedQuestions(
  attention: TendAttention[],
  decisions: Array<Pick<DecisionMeta, 'dispatch' | 'lane' | 'askedAt' | 'permission' | 'permissionsProposal'>> = listDecisions(),
): TendAttention[] {
  // A permission card frames nothing: it stands beside the trap's question, never in place of it.
  const frames = decisions.filter((d) => !d.permission && !d.permissionsProposal);
  return attention.filter(
    (a) =>
      a.kind !== 'question' ||
      !frames.some((d) => d.dispatch === a.id && (d.lane ?? 'work') === a.lane && d.askedAt >= (a.at ?? '')),
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
  };
}

/** Standing decisions as the glass renders them, newest first. */
export function glassDecisions(decisions: DecisionMeta[] = standingDecisions()): GlassDecision[] {
  return decisions.map((d) => {
    const viewedAt = decisionViewedAt(d.key);
    return {
    key: d.key,
    title: d.title,
    ...(d.appStart ? { appStart: d.appStart } : {}),
    detail: readDecisionDetail(d.key) ?? '',
    options: d.options,
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
    option: p.option ?? '',
    text: p.text ?? '',
    ...(p.run ? { runState: p.run.state, exitCode: String(p.run.exitCode), tail: p.run.tail } : {}),
    attachments: (p.attachments ?? []).map((a) => a.path).join(', '),
    from: r.from,
    at: r.at,
  };
}

/** A `man haul` line for a decision answer. */
export function decisionLine(r: LobstahRequest): string {
  const p = r.payload as unknown as DecisionAnswerPayload;
  const what = [
    p.option && `option "${p.option}"`,
    p.text && `text: ${p.text}`,
    p.attachments?.length > 0 && `files: ${p.attachments.map((a) => a.path).join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    `- decision-answer ${p.key}${p.dispatch ? ` (${p.dispatch})` : ''} — ${p.title} · ${what} (request ${r.id}). ` +
    'Act on it; for a dispatch, usually `lobstah send <dispatch> "<instruction>"`.'
  );
}
