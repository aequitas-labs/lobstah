import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectSoakSite } from '../src/soak-site.js';

function git(dir: string, ...args: string[]): void {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

let root: string;
let primary: string;
let linked: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-site-'));
  primary = path.join(root, 'repo');
  linked = path.join(root, 'repo-wt');
  fs.mkdirSync(primary);
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.email', 't@t');
  git(primary, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(primary, 'f'), 'x');
  git(primary, 'add', '.');
  git(primary, 'commit', '-m', 'init');
  git(primary, 'worktree', 'add', linked, '-b', 'side');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('inspectSoakSite', () => {
  const repos = () => ({ myrepo: { path: primary, trunk: 'main' } });

  it('flags the primary checkout and resolves its repo key', () => {
    const site = inspectSoakSite(primary, repos());
    expect(site?.primary).toBe(true);
    expect(site?.repoKey).toBe('myrepo');
  });

  it('a linked worktree is not primary but still resolves the repo key', () => {
    const site = inspectSoakSite(linked, repos());
    expect(site?.primary).toBe(false);
    expect(site?.repoKey).toBe('myrepo');
    expect(site?.worktree).toBe(path.resolve(fs.realpathSync.native(linked)));
  });

  it('an unconfigured repo yields no key; a non-repo yields nothing', () => {
    expect(inspectSoakSite(linked, {})?.repoKey).toBeUndefined();
    expect(inspectSoakSite(root, {})).toBeUndefined();
  });
});
