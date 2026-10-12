import { spawnSync } from 'node:child_process';
import { githubRepoFromOrigin } from '@lobstah/pick';
import type { Config } from '@lobstah/core';

let cached: { key: string; until: number; tools: Record<string, string> } | undefined;

/** Only opted-in repos need resolution. Cache path-only origin reads across glass polls. */
export function reviewTools(cfg: Pick<Config, 'repos'>, now = Date.now()): Record<string, string> {
  const repos = Object.entries(cfg.repos).filter(([, r]) => r.review && r.review !== 'github');
  const key = JSON.stringify(repos.map(([k, r]) => [k, r.path, r.origin, r.review]));
  if (cached?.key === key && now < cached.until) return cached.tools;
  const tools: Record<string, string> = {};
  for (const [, r] of repos) {
    const origin = r.origin ?? spawnSync('git', ['-C', r.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).stdout?.trim();
    const repo = origin && githubRepoFromOrigin(origin);
    if (repo) tools[repo.toLowerCase()] = r.review!;
  }
  cached = { key, until: now + 60_000, tools };
  return tools;
}
