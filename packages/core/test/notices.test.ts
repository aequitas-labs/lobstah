import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addWatch, enqueue, ensureLayout, listNotices, loadConfig, noticeFilterForGrounds, postNotice, unseenNotices } from '../src/index.js';
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

  it('can include selected quiet lifecycle notices in a summary without making other quiet notices visible', () => {
    postNotice({ kind: 'trap-stowed', text: 'stowed' });
    postNotice({ kind: 'pool-returned', text: 'pool returned' });
    expect(unseenNotices(true, undefined, undefined, ['trap-stowed']).map((n) => n.text)).toEqual(['stowed']);
    expect(unseenNotices(true)).toEqual([]);
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

  it('consumes owned notices after a foreign gap once while retaining the foreign notice', () => {
    postNotice({ kind: 'decision-answer', text: 'first', repo: 'a' });
    postNotice({ kind: 'bait-orphaned', text: 'foreign', repo: 'b' });
    postNotice({ kind: 'decision-answer', text: 'last', repo: 'a' });
    const mine = (n: { repo?: string }): boolean => n.repo === 'a';
    expect(unseenNotices(true, mine).map((n) => n.text)).toEqual(['first', 'last']);
    expect(unseenNotices(false, mine)).toEqual([]);
    expect(unseenNotices(true, mine)).toEqual([]);
    expect(unseenNotices(true, (n) => n.repo === 'b').map((n) => n.text)).toEqual(['foreign']);
    expect(unseenNotices(false)).toEqual([]);
  });

  it('keeps an unread foreign notice when more than 200 later notices are consumed', () => {
    postNotice({ kind: 'bait-orphaned', text: 'foreign', repo: 'b' });
    for (let index = 0; index < 205; index++) postNotice({ kind: 'decision-answer', text: String(index), repo: 'a' });
    expect(unseenNotices(true, (notice) => notice.repo === 'a')).toHaveLength(205);
    expect(unseenNotices(true, (notice) => notice.repo === 'a')).toEqual([]);
    expect(unseenNotices(true, (notice) => notice.repo === 'b').map((notice) => notice.text)).toEqual(['foreign']);
  });

  it('accepts a legacy cursor and retains acknowledgements across subsequent reads', () => {
    const old = postNotice({ kind: 'bait-orphaned', text: 'already read' })!;
    fs.writeFileSync(path.join(home, 'notices', '.cursor'), old.seq);
    postNotice({ kind: 'bait-orphaned', text: 'foreign', repo: 'b' });
    postNotice({ kind: 'decision-answer', text: 'new', repo: 'a' });
    expect(unseenNotices(true, (notice) => notice.repo === 'a').map((notice) => notice.text)).toEqual(['new']);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'notices', '.consumed'), 'utf8'))).toHaveLength(1);
    expect(unseenNotices(true).map((notice) => notice.text)).toEqual(['foreign']);
    expect(unseenNotices(false)).toEqual([]);
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

describe('notice grounds ownership', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(home, 'config.toml'), `
[repos.a]
path = "/repos/a"
origin = "https://github.com/acme/a.git"
[repos.b]
path = "/repos/b"
[grounds.alpha]
repos = ["a"]
[grounds.beta]
repos = ["b"]
`);
  });

  it('consumes an unowned stack notice between owned ones without replaying later answers', () => {
    const filter = noticeFilterForGrounds('alpha', loadConfig());
    postNotice({ kind: 'decision-answer', text: 'first', repo: 'a' });
    postNotice({ kind: 'stack-ready', text: 'unconfigured stack', repo: 'acme/external', refId: 'pr:acme/external#1' });
    const last = postNotice({ kind: 'decision-answer', text: 'last', repo: 'a' })!;
    expect(unseenNotices(true, filter).map((notice) => notice.text)).toEqual(['first', 'last']);
    expect(fs.readFileSync(path.join(home, 'notices', '.cursor'), 'utf8')).toBe(last.seq);
    expect(unseenNotices(false, filter)).toEqual([]);
    expect(unseenNotices(true, filter)).toEqual([]);
  });

  it('routes an unconfigured PR repo to the dispatch that registered its watch', () => {
    enqueue({ id: 'origin', repo: 'a', brief: 'Watch a PR outside the configured repos' });
    addWatch('pr:acme/external#1', 'unused', { owner: 'dispatch:origin' });
    postNotice({ kind: 'watch-failing', text: 'external PR', repo: 'acme/external', refId: 'pr:acme/external#1' });
    const cfg = loadConfig();
    expect(unseenNotices(true, noticeFilterForGrounds('beta', cfg))).toEqual([]);
    expect(unseenNotices(true, noticeFilterForGrounds('alpha', cfg)).map((notice) => notice.text)).toEqual(['external PR']);
    expect(unseenNotices(true, noticeFilterForGrounds('alpha', cfg))).toEqual([]);
  });

  it('lets the first reader consume an unowned notice with no surviving dispatch', () => {
    postNotice({ kind: 'watch-failing', text: 'unowned', repo: 'acme/external', grounds: 'removed' });
    const cfg = loadConfig();
    expect(unseenNotices(false, noticeFilterForGrounds('alpha', cfg))).toHaveLength(1);
    expect(unseenNotices(true, noticeFilterForGrounds('beta', cfg))).toHaveLength(1);
    expect(unseenNotices(true, noticeFilterForGrounds('alpha', cfg))).toEqual([]);
  });

  it('keeps configured repo and explicit grounds ownership ahead of the dispatch fallback', () => {
    enqueue({ id: 'origin', repo: 'a', brief: 'Original dispatch' });
    postNotice({ kind: 'bait-orphaned', text: 'beta repo', repo: 'b', refId: 'origin' });
    postNotice({ kind: 'bait-orphaned', text: 'beta desk', grounds: 'beta', refId: 'origin' });
    postNotice({ kind: 'bait-orphaned', text: 'alpha forge repo', repo: 'acme/a' });
    const cfg = loadConfig();
    expect(unseenNotices(true, noticeFilterForGrounds('alpha', cfg)).map((notice) => notice.text)).toEqual(['alpha forge repo']);
    expect(unseenNotices(true, noticeFilterForGrounds('alpha', cfg))).toEqual([]);
    expect(unseenNotices(true, noticeFilterForGrounds('beta', cfg)).map((notice) => notice.text)).toEqual(['beta repo', 'beta desk']);
  });
});
