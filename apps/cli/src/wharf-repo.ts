import { execFileSync } from 'node:child_process';
import { canonicalRepoRemote } from '@lobstah/core';
import type { Config } from '@lobstah/core';

/** Both helm and worker resolve the configured checkout, never its nickname. */
export function wharfRepoIdentity(config: Config, nickname: string): string {
  const repo = config.repos[nickname];
  try {
    if (!repo) throw new Error('not configured');
    const remote = execFileSync('git', ['-C', repo.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
    return canonicalRepoRemote(remote);
  } catch { throw new Error(`repo ${nickname} has no usable origin remote in its checkout; set git remote origin before using wharf dispatch or soak`); }
}
