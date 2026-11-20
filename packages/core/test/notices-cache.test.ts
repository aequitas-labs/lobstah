import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout } from '../src/paths.js';
import { listNotices, noticesDir, postNotice, pruneNotices, NOTICE_KEEP_MS } from '../src/notices.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-notices-cache-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

/** A notice file as an older lobstah would have left it, posted `ageMs` ago. */
function oldNotice(ageMs: number, kind: string, n: number): string {
  const at = Date.now() - ageMs;
  const seq = `${String(at).padStart(15, '0')}-1-${String(n).padStart(8, '0')}`;
  fs.mkdirSync(noticesDir(), { recursive: true });
  fs.writeFileSync(path.join(noticesDir(), `${seq}.json`), JSON.stringify({ seq, kind, at: new Date(at).toISOString(), text: `${kind} ${n}` }));
  return seq;
}

describe('notice listing', () => {
  it('answers from memory while the directory is unchanged, and sees adds, rewrites and removals', () => {
    const a = postNotice({ kind: 'dispatch-progress', text: 'first' })!;
    const b = postNotice({ kind: 'dispatch-progress', text: 'second' })!;
    const file = path.join(noticesDir(), `${a.seq}.json`);
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    fs.utimesSync(file, pinned, pinned);
    expect(listNotices(10).map((n) => n.text)).toEqual(['first', 'second']);

    // Change a file's bytes in place, keeping its size and mtime: a cached listing
    // still answers with what it read, so an unchanged file is never re-read.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"first"', '"FIRST"'));
    fs.utimesSync(file, pinned, pinned);
    expect(listNotices(10)[0]!.text).toBe('first');

    // A rewrite by rename (as pr-stacks updates a stack notice) is seen.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...a, text: 'rewritten' }));
    fs.renameSync(tmp, file);
    expect(listNotices(10).map((n) => n.text)).toEqual(['rewritten', 'second']);

    fs.rmSync(path.join(noticesDir(), `${b.seq}.json`));
    postNotice({ kind: 'dispatch-progress', text: 'third' });
    expect(listNotices(10).map((n) => n.text)).toEqual(['rewritten', 'third']);
    expect(listNotices(1).map((n) => n.text)).toEqual(['third']);

    // Callers get their own copies: changing one never changes the next listing.
    listNotices(10)[0]!.text = 'mutated';
    expect(listNotices(10)[0]!.text).toBe('rewritten');
  });

  it('prunes notices past the keep window, except standing stack notices', () => {
    const old = oldNotice(NOTICE_KEEP_MS + 86400_000, 'dispatch-progress', 1);
    const stack = oldNotice(NOTICE_KEEP_MS + 86400_000, 'stack-ready', 2);
    const recent = oldNotice(86400_000, 'dispatch-progress', 3);
    expect(pruneNotices()).toBe(1);
    expect(listNotices(10).map((n) => n.seq)).toEqual([stack, recent]);
    expect(listNotices(10).map((n) => n.seq)).not.toContain(old);
  });

  it('prunes at most once an hour, when a notice is posted', () => {
    oldNotice(NOTICE_KEEP_MS + 86400_000, 'dispatch-progress', 1);
    postNotice({ kind: 'dispatch-progress', text: 'now' });
    expect(listNotices(10).map((n) => n.text)).toEqual(['now']);
    const late = oldNotice(NOTICE_KEEP_MS + 86400_000, 'dispatch-progress', 2);
    postNotice({ kind: 'dispatch-progress', text: 'again' });
    expect(listNotices(10).map((n) => n.seq)).toContain(late);
  });
});
