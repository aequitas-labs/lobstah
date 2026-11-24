import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
}

function repository(dir: string): string {
  const common = fs.realpathSync.native(git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  return process.platform === 'win32' ? common.toLowerCase() : common;
}

/** Resolve by Git identity so orphaned checkouts also get their repository's policy. */
function ignoredPaths(dir: string): string[] {
  const repos = Object.values(loadConfig().repos).filter((repo) => repo.ignoreDirty?.length);
  if (!repos.length) return [];
  const common = repository(dir);
  return repos.flatMap((repo) => {
    try { return repository(repo.path) === common ? repo.ignoreDirty! : []; }
    catch { return []; } // An unavailable configured clone cannot identify this checkout.
  });
}

/** Count changes that must protect a checkout during cull and disk cleanup. Throws on unreadable Git state. */
export function cleanupModifiedFiles(dir: string): number {
  const roots = ignoredPaths(dir).map((root) => root.replace(/\/$/, ''));
  const ignored = (file: string, untracked: boolean): boolean => {
    const first = file.split('/')[0]!;
    const tooling = untracked && (file === '.lobstah-trap' || first === '.ume' || first === '.playwright-cli' || first.startsWith('.temp'));
    return tooling || roots.some((root) => file === root || file.startsWith(`${root}/`));
  };
  const records = git(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0');
  let modified = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('invalid git status record');
    const paths = [record.slice(3)];
    if (/^[RC]|^.[RC]/.test(record)) {
      const source = records[++i];
      if (!source) throw new Error('missing git rename source');
      paths.push(source);
    }
    if (!paths.every((file) => ignored(file, record.startsWith('?? ')))) modified++;
  }
  return modified;
}
