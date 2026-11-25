import { staleThreadResolveCommand } from '@lobstah/core';
import type { Notice } from '@lobstah/core';

/** A stale conversation's wake fields, shared by wait, report and the Stop hook. */
export function staleThreadNoticeFields(notice: Notice): Record<string, string> {
  const id = notice.refId!;
  return { notice: 'thread-stale', thread: id, text: notice.text, at: notice.at,
    next: `resolve it with \`${staleThreadResolveCommand(id)}\`` };
}
