import fs from 'node:fs';
import * as path from 'node:path';
import { uniqueTempPath, atomicRenameSync, lobstahHome } from './paths.js';
import { readStackEpochs, repoKey, stackReadyEnabled, stackStateHash } from './pr-stacks.js';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { dispatchProgress } from './dispatch-progress.js';
import { groundsList } from './helm.js';
import { storageGrounds } from './grounds-name.js';
import { storedDescriptor } from './queue.js';
import { parsePrRef } from './pr.js';
import { readPr } from './prs.js';
import { readWatch } from './watch.js';
import { withDirLock } from './dir-lock.js';

/**
 * Helm notices: the attention channel for events that are not status-log
 * entries — a trap signing on or going defective, addressed bait orphaned,
 * a message bounced. Anything the machinery decides NOT to act on by itself
 * lands here for the lobstah man to decide, instead of being silently
 * dropped or rerouted. Same observational stance as watch events: files on
 * disk, a consume cursor, and tend always shows the recent tail regardless
 * of consumption so nothing is ever invisible.
 */
export type NoticeKind =
  | 'trap-profile-missing'
  | 'assistance-result'
  | 'trap-signed-on'
  | 'trap-listening'
  | 'trap-available'
  | 'trap-batch'
  | 'trap-claim-idle'
  | 'dispatch-progress'
  | 'trap-idle-working'
  | 'trap-stowed'
  | 'trap-defective'
  | 'trap-ghosted'
  | 'trap-starting'
  | 'trap-start-failed'
  | 'trap-request'
  | 'decision-answer'
  | 'bait-orphaned'
  | 'message-bounced'
  | 'pr-merged'
  | 'pr-closed'
  | 'stack-ready'
  | 'stack-stopped'
  | 'watch-held'
  | 'watch-failing'
  | 'watch-recovered'
  | 'rate-limited'
  | 'rate-limit-recovered'
  | 'disk-held'
  | 'disk-cleared'
  | 'caches-cleared'
  | 'worktree-released'
  | 'push-failed'
  | 'repair-stopped'
  | 'pool-out'
  | 'pool-returned'
  | 'heavy-line-long'
  | 'heavy-over-limit';

/**
 * Notices that never wake a helm on their own: they show in tend, the
 * digest, and the glass. A trap's start is one wake, `trap-available`, when
 * it is listening; its reservation (`trap-starting`), sign-on
 * (`trap-signed-on`), and first park (`trap-listening`, older homes) ask
 * nothing of the helm, and neither does a sign-off (`trap-stowed`). A notice
 * can also be posted `quiet` on its own (a trap that ghosted while idle, a
 * trap available as part of a batch).
 */
export const QUIET_NOTICE_KINDS: readonly NoticeKind[] = ['trap-listening', 'trap-starting', 'trap-signed-on', 'trap-stowed', 'pool-returned', 'heavy-line-long'];

export interface Notice {
  /** Lexicographically ordered id — the filename stem. */
  seq: string;
  kind: NoticeKind;
  at: string;
  text: string;
  /** The dispatch, trap, or message this is about, when one exists. */
  refId?: string;
  /** Current top PR for a stack; its stable refId is not its click target. */
  url?: string;
  /** Repo key, so a helm can scope notices to its grounds. */
  repo?: string;
  /** Explicit ownership for repo-less notices. */
  grounds?: string;
  /** The session whose action caused it — consumed as usual, but never
   *  woken back at its own author (a helm's stow should not wake the helm
   *  to announce itself). */
  by?: string;
  /** Shown in tend, the digest, and the glass; never wakes a helm. */
  quiet?: boolean;
  /** A stack notice is delivered only while this epoch still stands. */
  stateHash?: string;
}

export function noticesDir(): string {
  return path.join(lobstahHome(), 'notices');
}

function cursorFile(): string {
  return path.join(noticesDir(), '.cursor');
}

/** Route unconfigured repos through their originating dispatch, then to the first reader. */
export function noticeFilterForGrounds(grounds: string, cfg: Config): (notice: Notice) => boolean {
  const configured = groundsList(cfg);
  const reader = storageGrounds(grounds, cfg);
  const groundsForRepo = (repo: string | undefined): string | undefined =>
    repo === undefined ? undefined : configured.find((entry) => entry.repos.includes(repoKey(cfg, repo)))?.name;
  return (notice: Notice): boolean => {
    const explicit = configured.find((entry) => entry.name === storageGrounds(notice.grounds ?? '', cfg))?.name;
    const owner = explicit ?? groundsForRepo(notice.repo);
    if (owner) return owner === reader;
    const dispatchIds: Array<string | undefined> = [notice.refId];
    for (const value of [notice.refId, notice.url]) {
      const ref = value ? parsePrRef(value) : undefined;
      if (!ref) continue;
      const watchOwner = readWatch(ref.key)?.owner;
      if (watchOwner?.startsWith('dispatch:')) dispatchIds.push(watchOwner.slice('dispatch:'.length));
      dispatchIds.push(...(readPr(ref.key)?.dispatches ?? []).slice().reverse());
    }
    for (const id of dispatchIds) {
      if (!id) continue;
      const dispatch = storedDescriptor(id, 'work') ?? storedDescriptor(id, 'chore');
      const target = configured.find((entry) => entry.name === dispatch?.target?.grounds)?.name;
      const dispatchGrounds = target ?? groundsForRepo(dispatch?.repo);
      if (dispatchGrounds) return dispatchGrounds === reader;
    }
    return true;
  };
}

/** Persist acknowledgements before advancing the shared cursor, so an interrupted write cannot replay them. */
function consumeNotices(filter: ((notice: Notice) => boolean) | undefined, consume: boolean): Notice[] {
  fs.mkdirSync(noticesDir(), { recursive: true });
  return withDirLock(`${cursorFile()}.lock`, () => {
    let seen = '';
    try {
      seen = fs.readFileSync(cursorFile(), 'utf8').trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const consumedFile = path.join(noticesDir(), '.consumed');
    let consumed: Set<string>;
    try {
      const acknowledged = JSON.parse(fs.readFileSync(consumedFile, 'utf8')) as string[];
      consumed = new Set(acknowledged.filter((seq) => seq > seen));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      consumed = new Set();
    }
    const fresh = listNotices(Number.MAX_SAFE_INTEGER).filter((notice) => notice.seq > seen);
    const owned = fresh.filter((notice) => !consumed.has(notice.seq) && (!filter || filter(notice)));
    if (consume && owned.length > 0) {
      for (const notice of owned) consumed.add(notice.seq);
      const consumedTemp = uniqueTempPath(consumedFile);
      fs.writeFileSync(consumedTemp, JSON.stringify([...consumed]));
      atomicRenameSync(consumedTemp, consumedFile);
      let through = seen;
      for (const notice of fresh) {
        if (!consumed.has(notice.seq)) break;
        through = notice.seq;
      }
      if (through > seen) {
        const cursorTemp = uniqueTempPath(cursorFile());
        fs.writeFileSync(cursorTemp, through);
        atomicRenameSync(cursorTemp, cursorFile());
      }
    }
    return owned;
  }, { staleMs: 30_000, waitMs: 2000, busy: () => new Error('Notice delivery is busy. Try again.') });
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
  url?: string;
  repo?: string;
  grounds?: string;
  /** The session whose action caused this — its own wakes skip the echo. */
  by?: string;
  dedupeKey?: string;
  /** Never wakes a helm (see Notice.quiet). */
  quiet?: boolean;
  stateHash?: string;
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
  const seq = `${String(Date.now()).padStart(15, '0')}-${process.pid}-${String(counter++).padStart(8, '0')}`;
  const notice: Notice = {
    seq,
    kind: n.kind,
    at: new Date().toISOString(),
    text: n.text,
    refId: n.refId,
    ...(n.url ? { url: n.url } : {}),
    repo: n.repo,
    ...(n.grounds ? { grounds: n.grounds } : {}),
    by: n.by,
    ...(n.quiet ? { quiet: true } : {}),
    ...(n.stateHash ? { stateHash: n.stateHash } : {}),
  };
  const file = path.join(dir, `${seq}.json`);
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(notice, null, 2));
  atomicRenameSync(tmp, file);
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
    .flatMap((f) => {
      try { return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Notice]; }
      catch (error) {
        // A stack shape may have been superseded since readdir. Readers
        // must not fail while the watch atomically updates its current item.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });
}

/**
 * Notices past the seen-cursor. `consume` advances the cursor over what is
 * returned. Acknowledgements past a foreign gap prevent repeat delivery
 * while leaving the foreign notice standing for its grounds.
 * `wakes` narrows what is returned among the owned notices: an owned notice
 * it rejects (e.g. one older than the helm's sign-on) is consumed without
 * waking anyone. A quiet kind (QUIET_NOTICE_KINDS) is consumed the same way:
 * it shows in tend and the glass, and it never wakes.
 */
export function unseenNotices(
  consume: boolean,
  filter?: (n: Notice) => boolean,
  wakes?: (n: Notice) => boolean,
): Notice[] {
  const owned = consumeNotices(filter, consume);
  const progress = owned.some((n) => n.kind === 'dispatch-progress' || n.kind === 'trap-idle-working') ? dispatchProgress() : [];
  const waking = owned.filter((n) => {
    if (n.quiet || QUIET_NOTICE_KINDS.includes(n.kind)) return false;
    if (n.kind === 'dispatch-progress' || n.kind === 'trap-idle-working') return progress.some((p) => p.id === n.refId && p.stateHash === n.stateHash);
    if (n.kind !== 'stack-ready') return true;
    const epoch = n.refId ? readStackEpochs()[n.refId] : undefined;
    return !!epoch?.ready && n.stateHash === stackStateHash({ id: n.refId! }, epoch.epoch) && stackReadyEnabled(loadConfig());
  });
  return wakes ? waking.filter(wakes) : waking;
}
