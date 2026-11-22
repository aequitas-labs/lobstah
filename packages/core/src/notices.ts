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
  | 'usage-limit'
  | 'usage-limit-warning'
  | 'usage-limit-reset'
  | 'trap-profile-missing'
  | 'assistance-result'
  | 'trap-signed-on'
  | 'trap-listening'
  | 'trap-available'
  | 'trap-batch'
  | 'trap-claim-idle'
  | 'trap-claim-released'
  | 'trap-not-receiving'
  | 'codex-hooks-stale'
  | 'codex-plugin-hooks'
  | 'dispatch-progress'
  | 'trap-idle-working'
  | 'trap-stowed'
  | 'trap-defective'
  | 'trap-ghosted'
  | 'trap-starting'
  | 'trap-start-failed'
  | 'trap-request'
  | 'decision-answer'
  | 'thread'
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
  | 'wharf-mirror-stale'
  | 'heavy-over-limit';

/**
 * Notices that never wake a helm on their own: they show in tend, the
 * digest, and the glass. A listening trap gives one `trap-available` wake
 * per free period; its reservation (`trap-starting`), sign-on
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
 * How long a notice is kept. Every reader that lists notices reads them all,
 * so an unpruned directory made each CLI call and each glass poll slower as
 * months of notices piled up. Stack-ready notices are kept: pr-stacks
 * rewrites and removes them itself while their stack stands. Dedupe markers
 * are kept, so a once-ever notice still never posts twice.
 */
export const NOTICE_KEEP_MS = 14 * 86400_000;
const PRUNE_EVERY_MS = 3600_000;

/** Remove notices older than keepMs. Returns how many were removed. */
export function pruneNotices(now = Date.now(), keepMs = NOTICE_KEEP_MS): number {
  const dir = noticesDir();
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  const cutoff = now - keepMs;
  for (const name of names) {
    // The name starts with the post time in ms, so most notices are judged without being read.
    const postedMs = Number(name.slice(0, 15));
    if (!Number.isFinite(postedMs) || postedMs >= cutoff) continue;
    const file = path.join(dir, name);
    try {
      if ((JSON.parse(fs.readFileSync(file, 'utf8')) as Notice).kind === 'stack-ready') continue;
      fs.rmSync(file, { force: true });
      forgetNoticeListing(name.slice(0, -'.json'.length));
      removed++;
    } catch {
      // Unreadable or already gone: leave it for the next pass.
    }
  }
  return removed;
}

/** Prune at most once an hour, across every process: a marker's mtime records the last pass. */
function pruneNoticesWhenDue(dir: string, now = Date.now()): void {
  const marker = path.join(dir, '.pruned');
  try {
    if (now - fs.statSync(marker).mtimeMs < PRUNE_EVERY_MS) return;
  } catch {
    // No marker yet: prune now.
  }
  try {
    fs.writeFileSync(marker, '');
  } catch {
    return;
  }
  pruneNotices(now);
}

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
  pruneNoticesWhenDue(dir);
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
  forgetNoticeListing(seq);
  return notice;
}

/** Rewrite a standing notice under its own seq, so its delivery position does not move. */
export function rewriteNotice(notice: Notice): void {
  const file = path.join(noticesDir(), `${notice.seq}.json`);
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, JSON.stringify(notice));
  atomicRenameSync(tmp, file);
  forgetNoticeListing(notice.seq);
}

export function removeNotice(seq: string): void {
  fs.rmSync(path.join(noticesDir(), `${seq}.json`), { force: true });
  forgetNoticeListing(seq);
}

/**
 * Parsed notices, kept for the life of the process: the glass lists every
 * notice on each poll, and re-reading thousands of files each time kept it
 * busy. Every write is a rename into the directory or a removal from it,
 * so an unchanged directory means unchanged notices. When it changes, a
 * file is re-read only if its mtime or size moved (a stack notice is
 * rewritten under the same name).
 */
const noticeCache: { dir?: string; stamp?: string; names: string[]; files: Map<string, { stamp: string; notice: Notice }> } = { names: [], files: new Map() };
const dirStamp = (st: fs.Stats) => `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;

/**
 * This process just wrote or removed a notice. The directory stamp can miss
 * that: two writes can land inside one timestamp tick, and Windows reports a
 * directory's size as 0. Re-list and re-read on the next call.
 */
function forgetNoticeListing(seq: string): void {
  noticeCache.stamp = undefined;
  noticeCache.files.delete(`${seq}.json`);
}

export function listNotices(limit = 20): Notice[] {
  const dir = noticesDir();
  let stamp: string;
  try {
    stamp = dirStamp(fs.statSync(dir));
  } catch {
    return [];
  }
  if (noticeCache.dir !== dir) {
    noticeCache.dir = dir;
    noticeCache.stamp = undefined;
    noticeCache.files.clear();
  }
  const fresh = noticeCache.stamp !== stamp;
  if (fresh) {
    try {
      noticeCache.names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const names = new Set(noticeCache.names);
    for (const name of noticeCache.files.keys()) if (!names.has(name)) noticeCache.files.delete(name);
    noticeCache.stamp = stamp;
  }
  return noticeCache.names.slice(-limit).flatMap((f) => {
    const cached = noticeCache.files.get(f);
    if (cached && !fresh) return [{ ...cached.notice }];
    const file = path.join(dir, f);
    try {
      const st = fs.statSync(file);
      const fileStamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
      if (cached?.stamp === fileStamp) return [{ ...cached.notice }];
      const notice = JSON.parse(fs.readFileSync(file, 'utf8')) as Notice;
      noticeCache.files.set(f, { stamp: fileStamp, notice });
      return [{ ...notice }];
    } catch (error) {
      // A stack shape may have been superseded since readdir. Readers
      // must not fail while the watch atomically updates its current item.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        noticeCache.files.delete(f);
        return [];
      }
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
 * it shows in tend and the glass, and it never wakes. `includeQuietKinds`
 * lets a caller include selected quiet state changes in its own summary.
 */
export function unseenNotices(
  consume: boolean,
  filter?: (n: Notice) => boolean,
  wakes?: (n: Notice) => boolean,
  /** Quiet notices to return for a non-waking summary, such as a Stop block. */
  includeQuietKinds: readonly NoticeKind[] = [],
): Notice[] {
  const owned = consumeNotices(filter, consume);
  const progress = owned.some((n) => n.kind === 'dispatch-progress' || n.kind === 'trap-idle-working') ? dispatchProgress() : [];
  const waking = owned.filter((n) => {
    if (n.quiet || QUIET_NOTICE_KINDS.includes(n.kind)) return includeQuietKinds.includes(n.kind);
    if (n.kind === 'dispatch-progress' || n.kind === 'trap-idle-working') return progress.some((p) => p.id === n.refId && p.stateHash === n.stateHash);
    if (n.kind !== 'stack-ready') return true;
    const epoch = n.refId ? readStackEpochs()[n.refId] : undefined;
    return !!epoch?.ready && n.stateHash === stackStateHash({ id: n.refId! }, epoch.epoch) && stackReadyEnabled(loadConfig());
  });
  return wakes ? waking.filter(wakes) : waking;
}
