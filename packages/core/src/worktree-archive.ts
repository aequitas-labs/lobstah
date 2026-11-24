import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** A recoverable checkout snapshot, including unresolved index stages and merge state. */
export interface WorktreeArchive {
  /** False means removal must leave the checkout in place. */
  saved: boolean;
  /** Archive directory in the repository's common Git directory; absent for clean checkouts. */
  directory?: string;
}

/** Git state needed to continue a merge, rebase, cherry-pick or revert. */
const OPERATION_FILES: readonly string[] = [
  'index', 'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE',
  'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD',
  'rebase-merge', 'rebase-apply', 'sequencer',
];

/**
 * Save uncommitted work before a checkout is removed. The archive contains
 * working files, the original index, an index-info manifest, operation state,
 * and a self-contained object pack for HEAD and every index stage. Nothing in
 * the checkout or its index is changed. Failure always forbids removal.
 */
export function archiveWorktree(dir: string, owner: string): WorktreeArchive {
  let temporary: string | undefined;
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  try {
    const status = git('status', '--porcelain=v1', '-z', '--untracked-files=all');
    const own = git('rev-parse', '--path-format=absolute', '--git-dir').trim();
    const operation = OPERATION_FILES.slice(2).some((name) => fs.existsSync(path.join(own, name)));
    if (!operation && !status.split('\0').some((entry) => entry && entry !== '?? .lobstah-trap')) return { saved: true };
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const root = path.join(common, 'lobstah', 'archives', encodeURIComponent(owner));
    fs.mkdirSync(root, { recursive: true });
    const name = `${Date.now()}-${randomUUID()}`;
    temporary = path.join(root, `.${name}`);
    fs.mkdirSync(temporary);
    const head = git('rev-parse', '--verify', 'HEAD').trim();
    const index = git('ls-files', '--stage', '-z');
    const changes = git('diff', '--no-ext-diff', '--binary', 'HEAD');
    const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))];
    const present: string[] = [];
    for (const file of files) {
      const source = path.join(dir, file);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(source); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // tracked deletion
        throw error;
      }
      // Submodule contents need their own archive; never silently discard them.
      if (stat.isDirectory()) return { saved: false };
      const target = path.join(temporary, 'files', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
      present.push(file);
    }
    fs.mkdirSync(path.join(temporary, 'git'));
    for (const name of [...OPERATION_FILES, ...fs.readdirSync(own).filter((file) => file.startsWith('sharedindex.'))]) {
      const source = path.join(own, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(temporary, 'git', name), { recursive: true, dereference: false });
    }
    const objects = new Set([head, ...index.split('\0').flatMap((entry) => {
      const match = /^\d+ ([a-f0-9]+) [0-3]\t/.exec(entry);
      return match ? [match[1]!] : [];
    })]);
    for (const name of ['ORIG_HEAD', 'MERGE_HEAD', 'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']) {
      const file = path.join(own, name);
      if (fs.existsSync(file)) for (const object of fs.readFileSync(file, 'utf8').trim().split(/\s+/)) {
        if (/^[a-f0-9]{40,64}$/.test(object)) objects.add(object);
      }
    }
    const pack = execFileSync('git', ['pack-objects', '--stdout', '--revs'], {
      cwd: dir, input: [...objects].join('\n') + '\n', timeout: 60_000,
      maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    fs.writeFileSync(path.join(temporary, 'objects.pack'), pack);
    fs.writeFileSync(path.join(temporary, 'index-info'), index);
    fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify({ head, files, present, worktree: dir }, null, 2));
    // Refuse removal if a concurrent writer changed either side of the snapshot.
    if (status !== git('status', '--porcelain=v1', '-z', '--untracked-files=all') ||
        index !== git('ls-files', '--stage', '-z') || changes !== git('diff', '--no-ext-diff', '--binary', 'HEAD')) return { saved: false };
    for (const file of present) {
      const source = path.join(dir, file);
      const target = path.join(temporary, 'files', file);
      if (fs.lstatSync(source).isSymbolicLink()) {
        if (fs.readlinkSync(source) !== fs.readlinkSync(target)) return { saved: false };
      } else if (!fs.readFileSync(source).equals(fs.readFileSync(target))) return { saved: false };
    }
    const directory = path.join(root, name);
    fs.renameSync(temporary, directory);
    temporary = undefined;
    return { saved: true, directory };
  } catch {
    return { saved: false };
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
