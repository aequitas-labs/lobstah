import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { archiveWorktree } from '../src/worktree-archive.js';
import { removeGhostWorktree } from '../src/worktree-safety.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let root: string;
let repo: string;
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-archive-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'conflict'), 'base\n');
  fs.writeFileSync(path.join(repo, 'stash-file'), 'base stash file\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
});
afterEach(() => removeTempDir(root));

it('recovers staged, unstaged, untracked and conflicted work after checkout removal', () => {
  git(repo, 'switch', '-qc', 'other');
  fs.writeFileSync(path.join(repo, 'conflict'), 'other\n');
  git(repo, 'commit', '-qam', 'other');
  git(repo, 'switch', '-q', 'main');
  const checkout = path.join(root, 'checkout');
  git(repo, 'worktree', 'add', '-qb', 'work', checkout);
  fs.writeFileSync(path.join(checkout, 'conflict'), 'ours\n');
  git(checkout, 'commit', '-qam', 'ours');
  fs.writeFileSync(path.join(checkout, 'stash-file'), 'work saved by merge autostash');
  expect(() => git(checkout, 'merge', '--autostash', 'other')).toThrow();
  const autostash = git(checkout, 'rev-parse', '--verify', 'MERGE_AUTOSTASH');
  fs.writeFileSync(path.join(checkout, 'staged'), 'staged content');
  git(checkout, 'add', 'staged');
  fs.writeFileSync(path.join(checkout, 'staged'), 'unstaged content');
  fs.writeFileSync(path.join(checkout, 'untracked'), 'untracked content');
  const stages = git(checkout, 'ls-files', '--stage');
  const conflict = fs.readFileSync(path.join(checkout, 'conflict'), 'utf8');
  const archived = archiveWorktree(checkout, 'trap-id');
  expect(archived.saved).toBe(true);
  expect(archived.directory).toBeTruthy();
  expect(git(checkout, 'ls-files', '--stage')).toBe(stages);
  git(repo, 'worktree', 'remove', '--force', checkout);
  const recovered = path.join(root, 'recovered');
  fs.mkdirSync(recovered);
  git(recovered, 'init', '-q');
  const archive = archived.directory!;
  execFileSync('git', ['index-pack', '--stdin'], { cwd: recovered, input: fs.readFileSync(path.join(archive, 'objects.pack')), stdio: ['pipe', 'pipe', 'pipe'] });
  fs.cpSync(path.join(archive, 'files'), recovered, { recursive: true });
  fs.cpSync(path.join(archive, 'git'), path.join(recovered, '.git'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'manifest.json'), 'utf8')) as { head: string };
  // The saved branch name may be absent in a fresh repository; detach at the saved HEAD.
  fs.writeFileSync(path.join(recovered, '.git', 'HEAD'), manifest.head + '\n');
  expect(git(recovered, 'ls-files', '--stage')).toBe(stages);
  expect(fs.readFileSync(path.join(recovered, 'conflict'), 'utf8')).toBe(conflict);
  expect(git(recovered, 'show', ':staged')).toBe('staged content');
  expect(fs.readFileSync(path.join(recovered, 'staged'), 'utf8')).toBe('unstaged content');
  expect(fs.readFileSync(path.join(recovered, 'untracked'), 'utf8')).toBe('untracked content');
  expect(git(recovered, 'cat-file', '-t', 'MERGE_HEAD')).toBe('commit');
  expect(git(recovered, 'show', `${autostash}:stash-file`)).toBe('work saved by merge autostash');
  expect(git(recovered, 'ls-files', '--unmerged').split('\n')).toHaveLength(3);
});

it('keeps the checkout when its archive cannot be written', () => {
  const checkout = path.join(root, 'checkout');
  git(repo, 'worktree', 'add', '-qb', 'work', checkout);
  fs.writeFileSync(path.join(checkout, '.lobstah-trap'), JSON.stringify({ trapId: 'trap-id' }));
  fs.writeFileSync(path.join(checkout, 'conflict'), 'unsaved');
  fs.writeFileSync(path.join(repo, '.git', 'lobstah'), 'blocks the archive directory');
  expect(archiveWorktree(checkout, 'trap-id').saved).toBe(false);
  expect(removeGhostWorktree(checkout).removed).toBe(false);
  expect(fs.readFileSync(path.join(checkout, 'conflict'), 'utf8')).toBe('unsaved');
});


it('packs a rebase autostash that is not reachable from HEAD or the index', () => {
  const checkout = path.join(root, 'rebasing');
  git(repo, 'worktree', 'add', '-qb', 'rebasing', checkout);
  fs.writeFileSync(path.join(checkout, 'stash-file'), 'work saved before rebase');
  const autostash = git(checkout, 'stash', 'create');
  git(checkout, 'reset', '--hard', 'HEAD');
  const state = path.join(git(checkout, 'rev-parse', '--absolute-git-dir'), 'rebase-merge');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'autostash'), autostash + '\n');
  const archived = archiveWorktree(checkout, 'rebasing-trap');
  expect(archived.saved).toBe(true);
  const recovered = path.join(root, 'recovered');
  fs.mkdirSync(recovered);
  git(recovered, 'init', '-q');
  execFileSync('git', ['index-pack', '--stdin'], { cwd: recovered, input: fs.readFileSync(path.join(archived.directory!, 'objects.pack')), stdio: ['pipe', 'pipe', 'pipe'] });
  expect(git(recovered, 'show', `${autostash}:stash-file`)).toBe('work saved before rebase');
  expect(fs.readFileSync(path.join(archived.directory!, 'git', 'rebase-merge', 'autostash'), 'utf8')).toBe(autostash + '\n');
});


it('does not authorize removal when the archive would be inside the checkout being removed', () => {
  fs.writeFileSync(path.join(repo, 'stash-file'), 'unsaved primary checkout');
  expect(archiveWorktree(repo, 'standalone').saved).toBe(false);
  expect(fs.readFileSync(path.join(repo, 'stash-file'), 'utf8')).toBe('unsaved primary checkout');
});
