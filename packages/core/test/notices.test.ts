import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
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
  vi.restoreAllMocks();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('helm notices', () => {
  it('tolerates a superseded stack shape removed between listing and reading', () => {
    const stale = postNotice({ kind: 'stack-ready', text: 'old shape' })!;
    postNotice({ kind: 'stack-ready', text: 'current shape' });
    const read = fs.readdirSync;
    const dir = path.join(home, 'notices');
    vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: Parameters<typeof read>) => {
      const files = read(...args);
      if (String(args[0]) === dir) fs.rmSync(path.join(dir, `${stale.seq}.json`), { force: true });
      return files;
    }) as typeof read);
    expect(listNotices().map((n) => n.text)).toEqual(['current shape']);
  });
  it('keeps delivery sequence order when several stack transitions share a millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T12:00:00Z'));
    for (let n = 0; n < 20; n++) postNotice({ kind: 'bait-orphaned', text: String(n) });
    expect(unseenNotices(true).map((n) => n.text)).toEqual(Array.from({ length: 20 }, (_, n) => String(n)));
    expect(unseenNotices(true)).toEqual([]);
  });
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
    // trap-ghosted: a kind that wakes unless the notice itself is quiet.
    postNotice({ kind: 'trap-ghosted', text: 'quiet', quiet: true });
    postNotice({ kind: 'trap-ghosted', text: 'normal' });
    expect(listNotices()[0]?.quiet).toBe(true);
    expect(listNotices()[1]?.quiet).toBeUndefined();
    expect(unseenNotices(true).map((n) => n.text)).toEqual(['normal']);
    expect(unseenNotices(false)).toEqual([]);
    expect(listNotices().map((n) => n.text)).toEqual(['quiet', 'normal']);
  });

  it("a trap's start wakes once, as trap-available; starting, sign-on, listening, and stow are quiet but listed", () => {
    postNotice({ kind: 'trap-starting', text: 'starting' });
    postNotice({ kind: 'trap-signed-on', text: 'signed on' });
    postNotice({ kind: 'trap-listening', text: 'listening (older homes)' });
    postNotice({ kind: 'trap-stowed', text: 'stowed' });
    expect(unseenNotices(false)).toEqual([]);
    expect(unseenNotices(true)).toEqual([]);
    expect(listNotices().map((n) => n.kind)).toEqual(['trap-starting', 'trap-signed-on', 'trap-listening', 'trap-stowed']);
    // Simulate a later event after consuming the initial quiet batch.
    const ms = Date.now();
    while (Date.now() === ms) {
      // wait for the next millisecond
    }
    postNotice({ kind: 'trap-available', text: 'available' });
    postNotice({ kind: 'trap-available', text: 'available in a batch', quiet: true });
    postNotice({ kind: 'trap-ghosted', text: 'ghosted idle', quiet: true });
    postNotice({ kind: 'trap-start-failed', text: 'did not start' });
    postNotice({ kind: 'trap-batch', text: 'batch settled' });
    expect(unseenNotices(true).map((n) => n.text).sort()).toEqual(['available', 'batch settled', 'did not start']);
    expect(unseenNotices(true)).toEqual([]);
    expect(listNotices(20).find((n) => n.text === 'ghosted idle')?.quiet).toBe(true);
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
    postNotice({ kind: 'bait-orphaned', text: 'old', repo: 'a' });
    postNotice({ kind: 'bait-orphaned', text: 'new', repo: 'a' });
    const mine = (n: { repo?: string }) => n.repo === 'a';
    const wakes = (n: { text: string }) => n.text !== 'old';
    expect(unseenNotices(true, mine, wakes).map((n) => n.text)).toEqual(['new']);
    expect(unseenNotices(true, mine, wakes)).toEqual([]);
    expect(listNotices().map((n) => n.text)).toEqual(['old', 'new']); // still listed
  });
});
