import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, listNotices, postNotice, unseenNotices } from '../src/index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-notices-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('helm notices', () => {
  it('posts in order and lists the recent tail', () => {
    postNotice({ kind: 'trap-signed-on', text: 'one' });
    postNotice({ kind: 'trap-listening', text: 'two' });
    expect(listNotices().map((n) => n.text)).toEqual(['one', 'two']);
  });

  it('a dedupeKey posts once, ever', () => {
    expect(postNotice({ kind: 'bait-orphaned', text: 'x', dedupeKey: 'orphan-a' })).toBeDefined();
    expect(postNotice({ kind: 'bait-orphaned', text: 'x again', dedupeKey: 'orphan-a' })).toBeUndefined();
    expect(listNotices()).toHaveLength(1);
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
});
