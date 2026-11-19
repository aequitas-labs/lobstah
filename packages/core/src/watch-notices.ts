import type { WatchNotice, WatchRegistry } from '@lobstah/watch-types';
import { builtinWatchRegistry } from './watch-source-registry.js';

/** The notice loop applies installed source policies without recognizing source kinds. */
export function watchNoticeCurrent(notice: WatchNotice, registry: WatchRegistry = builtinWatchRegistry()): boolean {
  return registry.list().every((source) => {
    if (!source.noticePolicy?.kinds.includes(notice.kind)) return true;
    try {
      return source.noticePolicy.current(notice);
    } catch {
      return true;
    } // Retain the existing card until its source can verify a replacement.
  });
}
export function watchNoticeQuiet(kind: string, registry: WatchRegistry = builtinWatchRegistry()): boolean {
  return registry.list().some((source) => source.noticePolicy?.quietKinds?.includes(kind));
}
export function watchNoticeDispatches(notice: WatchNotice, registry: WatchRegistry = builtinWatchRegistry()): string[] {
  return registry.list().flatMap((source) => {
    try {
      return source.noticePolicy?.relatedDispatches?.(notice) ?? [];
    } catch {
      return [];
    } // An unavailable optional router must not stop other sources.
  });
}
