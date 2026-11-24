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

/** Inventory used to restore an archived checkout into an empty directory. */
export interface WorktreeArchiveManifest {
  version: 1;
  /** Commit to use for the recovered checkout's detached HEAD. */
  head: string;
  /** Original checkout location, for identifying the saved work. */
  worktree: string;
  /** Indexed and untracked paths, including tracked deletions. */
  files: string[];
  /** Paths copied into files/; missing indexed paths stay deleted on recovery. */
  present: string[];
}

/** Git state needed to continue a merge, rebase, cherry-pick or revert. */
const OPERATION_FILES: readonly string[] = [
  'index', 'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE',
  'AUTO_MERGE', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD',
  'rebase-merge', 'rebase-apply', 'sequencer',
];

/** Compare saved bytes and file kinds without following symbolic links. */
function matchesArchive(source: string, saved: string): boolean {
  const stat = (file: string): fs.Stats | undefined => {
    try { return fs.lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const original = stat(source);
  const snapshot = stat(saved);
  if (!original || !snapshot) return original === snapshot;
  if (original.mode !== snapshot.mode) return false;
  if (original.isSymbolicLink()) return snapshot.isSymbolicLink() && fs.readlinkSync(source) === fs.readlinkSync(saved);
  if (original.isDirectory()) {
    if (!snapshot.isDirectory()) return false;
    const names = fs.readdirSync(source).sort();
    if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(saved).sort())) return false;
    return names.every((name) => matchesArchive(path.join(source, name), path.join(saved, name)));
  }
  return original.isFile() && snapshot.isFile() && fs.readFileSync(source).equals(fs.readFileSync(saved));
}

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
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const archiveLocation = path.relative(fs.realpathSync(dir), fs.realpathSync(common));
    // A standalone clone would take its archive with it when removed.
    if (!path.isAbsolute(archiveLocation) && archiveLocation !== '..' && !archiveLocation.startsWith(`..${path.sep}`)) return { saved: false };
    const operation = OPERATION_FILES.slice(2).some((name) => fs.existsSync(path.join(own, name)));
    if (!operation && !status.split('\0').some((entry) => entry && entry !== '?? .lobstah-trap')) return { saved: true };
    const root = path.join(common, 'lobstah', 'archives', encodeURIComponent(owner).replace(/\./g, '%2E'));
    fs.mkdirSync(root, { recursive: true });
    const name = `${Date.now()}-${randomUUID()}`;
    temporary = path.join(root, `.${name}`);
    fs.mkdirSync(temporary, { mode: 0o700 });
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
    const gitFiles = [...OPERATION_FILES, ...fs.readdirSync(own).filter((file) => file.startsWith('sharedindex.'))];
    for (const name of gitFiles) {
      const source = path.join(own, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(temporary, 'git', name), { recursive: true, dereference: false, verbatimSymlinks: true });
    }
    const objects = new Set([head, ...index.split('\0').flatMap((entry) => {
      const match = /^\d+ ([a-f0-9]+) [0-3]\t/.exec(entry);
      return match ? [match[1]!] : [];
    })]);
    for (const name of ['ORIG_HEAD', 'MERGE_HEAD', 'AUTO_MERGE', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge/autostash', 'rebase-apply/autostash']) {
      const file = path.join(temporary, 'git', name);
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
    const manifest: WorktreeArchiveManifest = { version: 1, head, files, present, worktree: dir };
    fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // Refuse removal if a concurrent writer changed either side of the snapshot.
    if (head !== git('rev-parse', '--verify', 'HEAD').trim() || status !== git('status', '--porcelain=v1', '-z', '--untracked-files=all') ||
        index !== git('ls-files', '--stage', '-z') || changes !== git('diff', '--no-ext-diff', '--binary', 'HEAD')) return { saved: false };
    if (!gitFiles.every((name) => matchesArchive(path.join(own, name), path.join(temporary!, 'git', name)))) return { saved: false };
    if (!present.every((file) => matchesArchive(path.join(dir, file), path.join(temporary!, 'files', file)))) return { saved: false };
    const directory = path.join(root, name);
    fs.renameSync(temporary, directory);
    temporary = undefined;
    return { saved: true, directory };
  } catch {
    return { saved: false };
  } finally {
    if (temporary) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); }
      catch { /* An incomplete hidden archive never authorizes removal. */ }
    }
  }
}
