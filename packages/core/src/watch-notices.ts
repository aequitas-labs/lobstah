import type { WatchNotice, WatchRegistry } from '@lobstah/watch-types';
import { builtinWatchRegistry } from './watch-source-registry.js';

/** The notice loop applies installed source policies without recognizing source kinds. */
export function watchNoticeCurrent(notice: WatchNotice, registry: WatchRegistry = builtinWatchRegistry()): boolean {
  return registry.list().every((source) => !source.noticePolicy?.kinds.includes(notice.kind) || source.noticePolicy.current(notice));
}
export function watchNoticeQuiet(kind: string, registry: WatchRegistry = builtinWatchRegistry()): boolean {
  return registry.list().some((source) => source.noticePolicy?.quietKinds?.includes(kind));
}
export function watchNoticeDispatches(notice: WatchNotice, registry: WatchRegistry = builtinWatchRegistry()): string[] {
  return registry.list().flatMap((source) => source.noticePolicy?.relatedDispatches?.(notice) ?? []);
}
