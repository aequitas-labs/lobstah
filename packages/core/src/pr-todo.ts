import type { WatchTriggerPolicy, WatchTriggerReading } from '@lobstah/watch-types';
import { parsePrRef } from './pr.js';
import { readPr } from './prs.js';
import { readWatch } from './watch.js';
import { WatchJournal } from './watch-journal.js';

/** PR todo conditions read cached records; only the CLI's preparation port refreshes the provider. */
export function prTodoTriggers(): WatchTriggerPolicy {
  return {
    parse(subject, condition) {
      if (!subject.startsWith('pr:')) return undefined;
      const reference = parsePrRef(subject);
      if (!reference) throw new Error(`not a PR reference: "${subject}": use pr:<owner>/<repo>#<number>`);
      if (!['merged', 'closed', 'green'].includes(condition ?? ''))
        throw new Error(`"${subject}" needs a condition to wait on: merged, closed, green`);
      return { key: reference.key, on: condition! };
    },
    read({ key, on }): WatchTriggerReading {
      const pr = readPr(key);
      if (!pr) return { state: 'lost' };
      if (on === 'merged') {
        if (pr.state === 'MERGED') return { state: 'met', as: 'merged' };
        return pr.state === 'CLOSED' ? { state: 'met', as: 'closed without merging' } : { state: 'waiting' };
      }
      if (on === 'closed') return pr.state === 'CLOSED' ? { state: 'met', as: 'closed' } : { state: 'waiting' };
      const { total, failed, pending, unknown } = pr.checks;
      return total > 0 && failed === 0 && pending === 0 && unknown === undefined ? { state: 'met', as: 'green' } : { state: 'waiting' };
    },
    needsWatch({ key }) {
      const registered = new WatchJournal().read(key);
      return (
        !readWatch(key) && (!registered || registered.status === 'retired') && !['MERGED', 'CLOSED'].includes(readPr(key)?.state ?? '')
      );
    },
    watchNote() {
      return 'also wakes the helm on failing checks and requested changes';
    },
  };
}
