import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, listNotices, postNotice, unseenNotices } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-notices-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('helm notices', () => {
  it('posts in order and lists the recent tail', () => {
    postNotice({ kind: 'trap-signed-on', text: 'one' });
    postNotice({ kind: 'trap-listening', text: 'two' });
    expect(listNotices().map((n) => n.text)).toEqual(['one', 'two']);
  });

  it('records who caused it, so wake paths can skip the author echo', () => {
    postNotice({ kind: 'trap-stowed', text: 'helm stow', by: 'helm-session' });
    expect(listNotices().at(-1)?.by).toBe('helm-session');
  });

  it('a dedupeKey posts once, ever', () => {
    expect(postNotice({ kind: 'bait-orphaned', text: 'x', dedupeKey: 'orphan-a' })).toBeDefined();
    expect(postNotice({ kind: 'bait-orphaned', text: 'x again', dedupeKey: 'orphan-a' })).toBeUndefined();
    expect(listNotices()).toHaveLength(1);
  });

  it('a per-notice quiet flag persists and consumes without changing other notices of the same kind', () => {
    postNotice({ kind: 'trap-signed-on', text: 'quiet', quiet: true });
    postNotice({ kind: 'trap-signed-on', text: 'normal' });
    expect(listNotices()[0]?.quiet).toBe(true);
    expect(listNotices()[1]?.quiet).toBeUndefined();
    expect(unseenNotices(true).map((n) => n.text)).toEqual(['normal']);
    expect(unseenNotices(false)).toEqual([]);
    expect(listNotices().map((n) => n.text)).toEqual(['quiet', 'normal']);
  });

  it('trap-listening never wakes on its own, is consumed, and still lists; sign-on and start-failed wake', () => {
    postNotice({ kind: 'trap-listening', text: 'listening' });
    expect(unseenNotices(false)).toEqual([]);
    expect(unseenNotices(true)).toEqual([]);
    expect(listNotices().map((n) => n.kind)).toEqual(['trap-listening']);
    postNotice({ kind: 'trap-signed-on', text: 'signed on' });
    postNotice({ kind: 'trap-listening', text: 'listening again' });
    postNotice({ kind: 'trap-start-failed', text: 'did not start' });
    expect(unseenNotices(true).map((n) => n.kind)).toEqual(['trap-signed-on', 'trap-start-failed']);
    expect(unseenNotices(true)).toEqual([]);
  });

  it('unseen consumes on read; a peek does not', () => {
    postNotice({ kind: 'trap-ghosted', text: 'gone' });
    expect(unseenNotices(false)).toHaveLength(1); // peek
    expect(unseenNotices(true)).toHaveLength(1); // consume
    expect(unseenNotices(true)).toHaveLength(0);
    postNotice({ kind: 'trap-ghosted', text: 'another' });
    expect(unseenNotices(true).map((n) => n.text)).toEqual(['another']);
  });

  it('a filtered consume leaves foreign notices standing for their owner', () => {
    postNotice({ kind: 'bait-orphaned', text: 'mine', repo: 'a' });
    postNotice({ kind: 'bait-orphaned', text: 'theirs', repo: 'b' });
    const mine = unseenNotices(true, (n) => n.repo === 'a');
    expect(mine.map((n) => n.text)).toEqual(['mine']);
    const theirs = unseenNotices(true, (n) => n.repo === 'b');
    expect(theirs.map((n) => n.text)).toEqual(['theirs']);
  });

  it('an owned notice the wake predicate rejects is consumed without waking, and never stalls the cursor', () => {
    postNotice({ kind: 'trap-stowed', text: 'old', repo: 'a' });
    postNotice({ kind: 'trap-stowed', text: 'new', repo: 'a' });
    const mine = (n: { repo?: string }) => n.repo === 'a';
    const wakes = (n: { text: string }) => n.text !== 'old';
    expect(unseenNotices(true, mine, wakes).map((n) => n.text)).toEqual(['new']);
    expect(unseenNotices(true, mine, wakes)).toEqual([]);
    expect(listNotices().map((n) => n.text)).toEqual(['old', 'new']); // still listed
  });
});
