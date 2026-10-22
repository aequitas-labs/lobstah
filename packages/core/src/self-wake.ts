import * as fs from 'node:fs';
import * as path from 'node:path';
import { attachmentBlock, copyAttachments, dispatchAttachmentsDir } from './attachments.js';
import { withDirLock } from './dir-lock.js';
import { appendEvent } from './events.js';
import { helmOf } from './helm.js';
import { sendMessage } from './inbox.js';
import { atomicRenameSync, lobstahHome, uniqueTempPath } from './paths.js';
import { cancelRequested } from './queue.js';
import { hasOpenCatch, readSessionClaim, readTrap, trapBySession, trapIdAbove } from './soak.js';
import { laneOf } from './worktrees.js';

export const SELF_WAKE_INTERVAL_MS = 30_000;
export const SELF_WAKE_MAX_BYTES = 8192;
const MAX_FILES = 4;

export class SelfWakeError extends Error {}

/** Resolve identity before considering a dispatch. No recipient is accepted. */
export function selfWakeTrap(cwd: string, sessionId?: string) {
  if (sessionId && helmOf(sessionId)) throw new SelfWakeError('inbox self is for a trap, not the helm');
  const anchored = trapIdAbove(cwd);
  const here = anchored ? readTrap(anchored) : undefined;
  if (anchored && !here) throw new SelfWakeError('this worktree has no signed-on trap');
  if (here && sessionId && here.sessionId !== sessionId) throw new SelfWakeError('session does not own this worktree trap');
  const reg = here ?? (sessionId ? trapBySession(sessionId) : undefined);
  if (!reg) throw new SelfWakeError('inbox self needs your signed-on trap worktree or --session');
  if (here) {
    const relative = path.relative(fs.realpathSync.native(reg.worktree), fs.realpathSync.native(cwd));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new SelfWakeError('worktree anchor does not belong to this trap');
  }
  return reg;
}

/** Queue only to the calling trap's active, verified catch; never advance status. */
export function sendSelfWake(opts: {
  cwd: string;
  sessionId?: string;
  /** Optional binding for a callback that must not follow the trap into its next catch. */
  dispatch?: string;
  text: string;
  files?: string[];
  maxAttachmentBytes: number;
  now?: number;
}) {
  if (!opts.text.trim() || Buffer.byteLength(opts.text, 'utf8') > SELF_WAKE_MAX_BYTES) throw new SelfWakeError('self-wake message must be non-empty and at most 8 KiB');
  const files = opts.files ?? [];
  if (files.length > MAX_FILES) throw new SelfWakeError('self-wake accepts at most four attachments');
  const first = selfWakeTrap(opts.cwd, opts.sessionId);
  const dir = path.join(lobstahHome(), 'self-wake');
  fs.mkdirSync(dir, { recursive: true });
  return withDirLock(path.join(dir, `${first.trapId}.lock`), () => {
    // Resolve again after the lock: stow, takeover, or reassignment may have happened.
    const reg = selfWakeTrap(opts.cwd, opts.sessionId ?? first.sessionId);
    if (reg.trapId !== first.trapId || !hasOpenCatch(reg)) throw new SelfWakeError('self-wake requires your active dispatch');
    const id = reg.claimed!;
    const lane = laneOf(id)!;
    const claim = readSessionClaim(id, lane);
    if (claim?.by !== `wt:${reg.trapId}` || fs.realpathSync.native(claim.worktree) !== fs.realpathSync.native(reg.worktree)) {
      throw new SelfWakeError('dispatch claim does not belong to this trap');
    }
    if (opts.dispatch !== undefined && opts.dispatch !== id) throw new SelfWakeError('self-wake cannot target a different dispatch');
    if (cancelRequested(id, lane)) throw new SelfWakeError('self-wake dispatch was cancelled');
    const now = opts.now ?? Date.now();
    const stamp = path.join(dir, `${reg.trapId}.json`);
    let last: number | undefined;
    try {
      last = (JSON.parse(fs.readFileSync(stamp, 'utf8')) as { at: number }).at;
      if (!Number.isFinite(last)) throw new SelfWakeError('self-wake rate record is invalid');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (last !== undefined && now - last < SELF_WAKE_INTERVAL_MS) throw new SelfWakeError(`self-wake rate limit: retry in ${Math.ceil((SELF_WAKE_INTERVAL_MS - (now - last)) / 1000)}s`);
    if (files.reduce((n, f) => n + fs.statSync(f).size, 0) > opts.maxAttachmentBytes) throw new SelfWakeError('self-wake attachments exceed the attachment limit');
    const attachments = copyAttachments(files, dispatchAttachmentsDir(id, lane), opts.maxAttachmentBytes);
    const text = `[from self]\n${[opts.text, attachmentBlock(attachments)].filter(Boolean).join('\n\n')}`;
    if (Buffer.byteLength(text, 'utf8') > SELF_WAKE_MAX_BYTES || attachments.reduce((n, a) => n + a.bytes, 0) > opts.maxAttachmentBytes) {
      for (const a of attachments) fs.rmSync(a.path, { force: true });
      throw new SelfWakeError('self-wake payload exceeds its size limit');
    }
    // Reserve before publishing, so an I/O retry cannot flood the inbox.
    const tmp = uniqueTempPath(stamp);
    fs.writeFileSync(tmp, JSON.stringify({ at: now, dispatch: id }));
    atomicRenameSync(tmp, stamp);
    const file = sendMessage(id, lane, text, 'self', attachments);
    appendEvent(id, lane, { at: new Date(now).toISOString(), type: 'self', data: { trap: `wt:${reg.trapId}`, file, text: opts.text, attachments } });
    return { id, lane, trap: `wt:${reg.trapId}`, from: 'self', queued: file };
  }, { staleMs: 5000, waitMs: 5000, busy: () => new SelfWakeError('self-wake is busy; try again') });
}
