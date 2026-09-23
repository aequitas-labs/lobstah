import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome } from './paths.js';

/**
 * Helm notices: the attention channel for events that are not status-log
 * entries — a trap signing on or going defective, addressed bait orphaned,
 * a message bounced. Anything the machinery decides NOT to act on by itself
 * lands here for the lobsterman to decide, instead of being silently
 * dropped or rerouted. Same observational stance as watch events: files on
 * disk, a consume cursor, and tend always shows the recent tail regardless
 * of consumption so nothing is ever invisible.
 */
export type NoticeKind =
  | 'trap-signed-on'
  | 'trap-listening'
  | 'trap-stowed'
  | 'trap-defective'
  | 'trap-ghosted'
  | 'bait-orphaned'
  | 'message-bounced'
  | 'pr-merged'
  | 'pr-closed';

export interface Notice {
  /** Lexicographically ordered id — the filename stem. */
  seq: string;
  kind: NoticeKind;
  at: string;
  text: string;
  /** The dispatch, trap, or message this is about, when one exists. */
  refId?: string;
  /** Repo key, so a helm can scope notices to its grounds. */
  repo?: string;
  /** The session whose action caused it — consumed as usual, but never
   *  woken back at its own author (a helm's stow should not wake the helm
   *  to announce itself). */
  by?: string;
}

export function noticesDir(): string {
  return path.join(lobstahHome(), 'notices');
}

function cursorFile(): string {
  return path.join(noticesDir(), '.cursor');
}

let counter = 0;

/**
 * Post a notice. A `dedupeKey` makes it once-ever: the same key never posts
 * twice (a standing condition should nag through tend's tail, not by
 * re-posting). Returns undefined when deduped. Only standing conditions that
 * are re-observed on a scan loop take a key — and the key must name the
 * condition's epoch (e.g. an enlistment's signedOnAt), or a recurrence is
 * silently swallowed. A transition event (sign-on, first park, sign-off,
 * ghosting) is gated by the state change itself and takes no key.
 */
export function postNotice(n: {
  kind: NoticeKind;
  text: string;
  refId?: string;
  repo?: string;
  /** The session whose action caused this — its own wakes skip the echo. */
  by?: string;
  dedupeKey?: string;
}): Notice | undefined {
  const dir = noticesDir();
  fs.mkdirSync(dir, { recursive: true });
  if (n.dedupeKey) {
    const marker = path.join(dir, `.dedupe-${n.dedupeKey.replace(/[^A-Za-z0-9_-]/g, '_')}`);
    try {
      fs.writeFileSync(marker, '', { flag: 'wx' });
    } catch {
      return undefined; // already posted
    }
  }
  const seq = `${String(Date.now()).padStart(15, '0')}-${process.pid}-${counter++}`;
  const notice: Notice = {
    seq,
    kind: n.kind,
    at: new Date().toISOString(),
    text: n.text,
    refId: n.refId,
    repo: n.repo,
    by: n.by,
  };
  const file = path.join(dir, `${seq}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notice, null, 2));
  fs.renameSync(tmp, file);
  return notice;
}

export function listNotices(limit = 20): Notice[] {
  const dir = noticesDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .sort()
    .slice(-limit)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Notice);
}

/**
 * Notices past the seen-cursor. `consume` advances the cursor over what is
 * returned; a filter leaves non-matching notices standing for their owner
 * (per-grounds consumption — one helm never eats another's notices).
 */
export function unseenNotices(consume: boolean, filter?: (n: Notice) => boolean): Notice[] {
  let seen = '';
  try {
    seen = fs.readFileSync(cursorFile(), 'utf8').trim();
  } catch {
    // never consumed
  }
  const fresh = listNotices(200).filter((n) => n.seq > seen);
  const matched = filter ? fresh.filter(filter) : fresh;
  if (consume && matched.length > 0) {
    if (!filter) {
      fs.writeFileSync(cursorFile(), fresh.at(-1)!.seq);
    } else {
      // Advance only through the contiguous consumed prefix, so a foreign
      // notice interleaved between ours stays standing for its owner.
      let through = seen;
      for (const n of fresh) {
        if (!filter(n)) break;
        through = n.seq;
      }
      if (through > seen) fs.writeFileSync(cursorFile(), through);
    }
  }
  return matched;
}
