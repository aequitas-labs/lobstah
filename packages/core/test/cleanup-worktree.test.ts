import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanupModifiedFiles } from '../src/cleanup-worktree.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let repo: string;
function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
}
function write(file: string, content = 'generated'): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}
function configure(paths: string[]): void {
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(repo)}\nignoreDirty = ${JSON.stringify(paths)}\n`);
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cleanup-'));
  process.env.LOBSTAH_HOME = home;
  repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

describe('cleanupModifiedFiles', () => {
  it('ignores untracked tooling files but preserves tracked changes inside tooling directories', () => {
    write('.ume/policies/rules.yaml', 'policy');
    git('add', '.');
    git('commit', '-qm', 'policy');
    for (const file of ['.lobstah-trap', '.ume/next.json', '.temp/scratch', '.temp-output', '.playwright-cli/session']) write(file);
    expect(cleanupModifiedFiles(repo)).toBe(0);
    write('.ume/policies/rules.yaml', 'edited policy');
    expect(cleanupModifiedFiles(repo)).toBe(1);
  });

  it('ignores configured tracked, staged, deleted and untracked output while protecting neighboring files', () => {
    for (const file of ['apps/design/generated.ts', 'apps/design/generated.css', 'apps/design/deleted.ts']) write(file);
    git('add', '.');
    git('commit', '-qm', 'output');
    configure(['apps/design/generated.ts', 'apps/design/generated.css', 'apps/design/deleted.ts', 'cache/']);
    write('apps/design/generated.ts', 'rebuilt');
    git('add', 'apps/design/generated.ts');
    write('apps/design/generated.css', 'rebuilt');
    fs.unlinkSync(path.join(repo, 'apps/design/deleted.ts'));
    write('cache/new file.txt');
    expect(cleanupModifiedFiles(repo)).toBe(0);
    write('apps/design/generated.ts.bak');
    write('cache-other/notes');
    expect(cleanupModifiedFiles(repo)).toBe(2);
  });

  it('protects renames across an ignored boundary in either direction', () => {
    write('source.ts', 'source code');
    write('generated/old.ts', 'generated output');
    git('add', '.');
    git('commit', '-qm', 'source and output');
    configure(['generated']);
    git('mv', 'source.ts', 'generated/source.ts');
    expect(cleanupModifiedFiles(repo)).toBe(1);
    git('mv', 'generated/old.ts', 'source-old.ts');
    expect(cleanupModifiedFiles(repo)).toBe(2);
    git('mv', 'generated/source.ts', 'generated/new.ts');
    expect(cleanupModifiedFiles(repo)).toBe(2);
    configure(['generated', 'source.ts', 'source-old.ts']);
    expect(cleanupModifiedFiles(repo)).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('reads paths containing spaces, quotes and newlines without splitting status records', () => {
    const files = ['out/a b.txt', 'out/a"b.txt', 'out/a\nb.txt'];
    for (const file of files) write(file);
    configure(files);
    expect(cleanupModifiedFiles(repo)).toBe(0);
    write('real\nnotes.txt');
    expect(cleanupModifiedFiles(repo)).toBe(1);
  });

  it('does not apply another repository’s ignore list', () => {
    const other = path.join(home, 'other');
    fs.mkdirSync(other);
    execFileSync('git', ['init', '-q', other]);
    fs.writeFileSync(path.join(home, 'config.toml'), `[repos.other]\npath = ${JSON.stringify(other)}\nignoreDirty = ["notes.txt"]\n`);
    write('notes.txt');
    expect(cleanupModifiedFiles(repo)).toBe(1);
  });

  it('fails closed when git state cannot be read', () => {
    expect(() => cleanupModifiedFiles(home)).toThrow();
  });
});
