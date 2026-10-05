import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { listDecisions, lobstahHome, postNotice } from '@lobstah/core';
import type { HelmConfig, HelmRegistration } from '@lobstah/core';
import type { HookInput } from './soak-site.js';

/** Conservative English heuristic: direct address, choices, or permission to act. */
export function extractHumanQuestions(text: string): string[] {
  let fence: { char: string; length: number } | undefined;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = { char: mark[0]!, length: mark.length };
      else if (mark[0] === fence.char && mark.length >= fence.length) fence = undefined;
      lines.push('');
      continue;
    }
    if (fence || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line)) {
      lines.push('');
      continue;
    }
    lines.push(line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/, ''));
  }
  const prose = lines
    .join('\n')
    .replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'(?!\w)|‘[^’\n]*’/g, '')
    .replace(/\*\*|__/g, '');
  const questions: string[] = [];
  for (const paragraph of prose.split(/\n\s*\n/)) {
    for (const match of paragraph.replace(/\s+/g, ' ').matchAll(/[^.!?]+\?/g)) {
      const q = match[0].trim();
      // Expository headings are not requests, even when they mention "you".
      if (/^(?:why (?:does|is|this|that)|how (?:does|is|this|that)|what (?:is|does) (?:this|that)|what if|who knows)\b/i.test(q)) continue;
      if (
        /\b(?:you|your)\b/i.test(q) ||
        /^(?:(?:shall|should|can|could|would|may) (?:I|we)\b|which\b|what (?:option|choice|approach|next|should)\b|is that (?:okay|ok|fine)\b|(?:proceed|go ahead|approve|confirm|ship|dispatch)\b)/i.test(
          q,
        )
      )
        questions.push(q);
    }
  }
  return [...new Set(questions)];
}

interface TurnMessage {
  id: string;
  text: string;
  turnId?: string;
  start?: number;
}
type Row = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: { id?: string; role?: string; content?: unknown };
  payload?: { type?: string; turn_id?: string; role?: string; phase?: string; content?: unknown };
};
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b?.type === 'text' || b?.type === 'output_text')
          .map((b) => b.text ?? '')
          .join('\n')
      : '';
const timeOf = (row: Row): number | undefined => {
  const n = Date.parse(row.timestamp ?? '');
  return Number.isFinite(n) ? n : undefined;
};

/** Read only a bounded tail, never discover private logs from a session id. */
function transcriptRows(file: string): Row[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - 2 * 1024 * 1024);
    const bytes = Buffer.alloc(size - offset);
    fs.readSync(fd, bytes, 0, bytes.length, offset);
    const lines = bytes.toString('utf8').split('\n');
    if (offset) lines.shift();
    return lines.flatMap((line) => {
      try {
        const r = JSON.parse(line);
        return r && typeof r === 'object' ? [r as Row] : [];
      } catch {
        return [];
      }
    });
  } finally {
    fs.closeSync(fd);
  }
}

/** Claude JSONL user/tool/assistant records; Codex uses its exposed final text when available. */
export function endingMessage(hook: HookInput, harness?: string): TurnMessage | undefined {
  let rows: Row[] = [];
  try {
    if (typeof hook.transcript_path === 'string') rows = transcriptRows(hook.transcript_path);
  } catch {
    /* direct text still works */
  }
  let start: number | undefined;
  let turnId = hook.turn_id;
  let last: TurnMessage | undefined;
  for (const row of rows) {
    const human =
      row.type === 'user' &&
      !row.isMeta &&
      textOf(row.message?.content) &&
      !(Array.isArray(row.message?.content) && row.message.content.some((b) => b?.type === 'tool_result'));
    const codexStart =
      row.type === 'event_msg' && row.payload?.type === 'task_started' && (!hook.turn_id || row.payload.turn_id === hook.turn_id);
    if (human || codexStart) {
      start = timeOf(row);
      turnId = codexStart ? row.payload?.turn_id : (row.uuid ?? row.timestamp);
      last = undefined;
    }
    const content =
      row.type === 'assistant'
        ? row.message?.content
        : row.type === 'response_item' && row.payload?.role === 'assistant' && row.payload.phase !== 'commentary'
          ? row.payload.content
          : undefined;
    const text = textOf(content);
    if (text) last = { id: row.uuid ?? row.message?.id ?? row.timestamp ?? hash(text), text, start, turnId };
  }
  if (typeof hook.last_assistant_message === 'string') {
    const text = hook.last_assistant_message;
    return { id: last?.text === text ? last.id : hash(`${hook.turn_id ?? ''}\n${text}`), text, start, turnId: hook.turn_id ?? turnId };
  }
  // Do not interpret an unknown harness's transcript format as Claude's.
  return harness === 'claude' || harness === 'codex' ? last : undefined;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
interface GuardMarker {
  messageId: string;
  turnId?: string;
}

/** Returns only the extra block reason; warn leaves a quiet tend notice instead. Never throws. */
export function helmQuestionGuard(
  hook: HookInput | undefined,
  helm: HelmRegistration | undefined,
  mode: HelmConfig['questionGuard'],
): string | undefined {
  if (!helm || !hook || mode === 'off' || !['block', 'warn'].includes(mode) || hook.stop_hook_active) return undefined;
  if (typeof hook.last_assistant_message === 'string' && !extractHumanQuestions(hook.last_assistant_message).length) return undefined;
  try {
    const message = endingMessage(hook, helm.harness);
    if (!message) return undefined;
    const questions = extractHumanQuestions(message.text);
    if (!questions.length) return undefined;
    const file = path.join(lobstahHome(), 'question-guard', `${hash(helm.sessionId)}.json`);
    let prior: GuardMarker | undefined;
    try {
      prior = JSON.parse(fs.readFileSync(file, 'utf8')) as GuardMarker;
    } catch {
      /* first stop */
    }
    if (prior?.messageId === message.id || (message.turnId && prior?.turnId === message.turnId)) return undefined;
    // Any new/replaced card in this turn suffices, not a fuzzy text match.
    // Without a trustworthy turn boundary, old cards must not suppress the nudge.
    if (
      message.start !== undefined &&
      listDecisions().some(
        (d) =>
          d.askedBy === 'helm' &&
          d.grounds === helm.grounds &&
          (!d.askedBySession || d.askedBySession === helm.sessionId) &&
          Date.parse(d.askedAt) >= message.start!,
      )
    )
      return undefined;
    const preview = questions
      .slice(0, 4)
      .map((q) => JSON.stringify(q.length > 180 ? `${q.slice(0, 179)}…` : q))
      .join(', ');
    const reason =
      `You asked the human ${questions.length} question(s) in chat without a card: ${preview}${questions.length > 4 ? ', …' : ''}. ` +
      'Put each decision on a card with `lobstah man ask --title "<question>" --option "<choice>"` (detail file optional), or, if they are rhetorical or already answered, end the turn again.';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ messageId: message.id, turnId: message.turnId } satisfies GuardMarker));
    fs.renameSync(tmp, file);
    if (mode === 'warn') {
      postNotice({
        kind: 'helm-question-guard',
        text: reason,
        by: helm.sessionId,
        dedupeKey: `question-guard-${hash(`${helm.sessionId}:${message.turnId ?? message.id}`)}`,
      });
      return undefined;
    }
    return reason;
  } catch {
    return undefined;
  } // unreadable/malformed transcripts never break a stop
}
