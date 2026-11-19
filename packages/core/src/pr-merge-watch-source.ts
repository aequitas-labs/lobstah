import { createHash } from 'node:crypto';
import { PrMergeWatchType } from '@lobstah/watch-types';
import type { PrMergeWatchServices } from '@lobstah/watch-types';
import { readPr } from './prs.js';
import { prMergeStatus } from './pr-merge.js';

export type PrMergeWatchSourceOptions = Pick<PrMergeWatchServices, 'automation' | 'effectHandler'>;

/** The request remains in the PR record; the watch owns scheduling and effect receipts. */
export function createPrMergeWatchType(options: PrMergeWatchSourceOptions = {}): PrMergeWatchType {
  return new PrMergeWatchType({
    ...options,
    observe({ snapshot }) {
      const pr = readPr(snapshot.reference.key),
        request = pr?.mergeRequest;
      return {
        cursor: createHash('sha256')
          .update(JSON.stringify([pr?.headSha, pr?.state, request]))
          .digest('hex'),
        events: [],
        ...(!request || (pr?.state === 'MERGED' && request.status === 'merged' && !request.retargetPending) ? { done: true } : {}),
      };
    },
    present(snapshot) {
      const pr = readPr(snapshot.reference.key),
        request = pr?.mergeRequest;
      return {
        title: pr?.title ?? snapshot.reference.key,
        summary: pr ? prMergeStatus(pr) : '',
        label: 'Merge request',
        tone: request?.error ? 'risk' : 'neutral',
        worker: {
          steps: ['Read the recorded merge request, its method and any hold. A request authorizes only the source’s checked revision.'],
        },
        helm: {
          steps: [
            'A merge action requires a recorded request. Inspect an incomplete submission on GitHub before explicitly withdrawing and requesting it again.',
          ],
          read: { executable: 'lobstah', args: ['prs'] },
        },
        rows: request
          ? [
              { label: 'Authorized by', value: request.by },
              { label: 'Method', value: request.method },
              { label: 'Status', value: prMergeStatus(pr!) },
            ]
          : [],
        links: [{ label: 'Open pull request', url: snapshot.reference.url }],
        actions: [{ id: 'advance', label: 'Advance authorized merge', requiresAuthority: true, automatic: true }],
        attention: [],
      };
    },
    failure(error) {
      return { kind: 'merge', message: error instanceof Error ? error.message : String(error) };
    },
  });
}
