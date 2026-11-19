import { loadConfig, parsePrRef, toonKV, toonTable } from '@lobstah/core';
import { PR_WATCH_INPUT_PATTERN } from '@lobstah/watch-types';
import type { WatchCommandPolicy } from '@lobstah/watch-types';
import { backfillPrWatches, removePrWatch, runPrCheck } from '../pr-watch.js';

/** Compatibility commands and their output belong to the source that implements them. */
export function prWatchCommands(): WatchCommandPolicy {
  return {
    bindings: [{ name: 'check-pr' }, { name: 'backfill' }, { name: 'rm', pattern: PR_WATCH_INPUT_PATTERN }],
    run({ name, args, flags }) {
      const opt = (key: string) => (typeof flags[key] === 'string' ? (flags[key] as string) : undefined);
      if (name === 'check-pr') {
        loadConfig({ upgrade: true });
        if (!args[0]) throw new Error('watch check-pr requires pr:<owner>/<repo>#<n>');
        return runPrCheck(args[0], opt('--cursor'), opt('--for'));
      }
      if (name === 'rm') {
        const ref = parsePrRef(args[0]!)!;
        const { removed, stale } = removePrWatch(ref);
        return (
          toonKV({ key: ref.key, removed }) +
          (stale ? `\nwarning: could not refresh ${ref.key} before removing its watch; its record may be stale (${stale})` : '')
        );
      }
      const apply = flags['--apply'] === true;
      const rows = backfillPrWatches({ apply });
      return [
        toonTable(
          'backfill',
          rows.map((row) => ({ ...row })),
          rows.some((row) => row.error) ? ['key', 'action', 'owner', 'error'] : ['key', 'action', 'owner'],
        ),
        toonKV({
          applied: apply,
          register: rows.filter((row) => row.action === 'register').length,
          retire: rows.filter((row) => row.action === 'retire').length,
          title: rows.filter((row) => row.action === 'title' && !row.error).length,
        }),
        ...(!apply && rows.length ? ['dry run — pass --apply to write'] : []),
      ].join('\n');
    },
  };
}
