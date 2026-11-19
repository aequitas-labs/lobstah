import fs from 'node:fs';
import type { WatchAcknowledgementPolicy } from '@lobstah/watch-types';
import { laneDirs } from './paths.js';
import { parsePrRef, prReadyStateHash } from './pr.js';
import { readPr } from './prs.js';
import { readEvidence } from './evidence.js';
import { readStackEpochs } from './stack-watch-state.js';
import type { Lane } from './types.js';

/** Legacy PR and stack item keys retain source-owned acknowledgement rules. */
export function prAcknowledgements(): WatchAcknowledgementPolicy {
  return {
    patterns: ['^pr:', '^stack:'],
    retain(ack, standing) {
      const head = (standing as { headSha?: string } | undefined)?.headSha;
      return ack.kind === 'pr:ready' && typeof head === 'string' && ack.stateHash === prReadyStateHash(head);
    },
    exists(key, culling) {
      if (key.startsWith('stack:')) {
        const root = key.slice(6),
          stack = readStackEpochs()[root];
        return stack ? Object.keys(stack.heads).some((member) => readPr(member)?.state === 'OPEN') : readPr(root)?.state === 'OPEN';
      }
      const reference = key.startsWith('pr:') ? parsePrRef(key) : undefined;
      if (!reference) return undefined;
      const record = readPr(reference.key);
      if (record) return record.state === 'OPEN';
      for (const lane of ['work', 'chore'] as Lane[]) {
        let files: string[];
        try {
          files = fs.readdirSync(laneDirs(lane).state).filter((file) => file.endsWith('.evidence'));
        } catch {
          continue;
        }
        for (const file of files) {
          const id = file.slice(0, -'.evidence'.length);
          if (culling.includes(id)) continue;
          const pr = readEvidence(id, lane).pr;
          if (pr && parsePrRef(pr.url)?.key === reference.key && pr.state === 'OPEN') return true;
        }
      }
      return false;
    },
  };
}
