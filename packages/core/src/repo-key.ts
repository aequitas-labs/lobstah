import type { Config } from './config.js';

export function repoKey(cfg: Config, forgeRepo: string): string {
  return (
    Object.entries(cfg.repos).find(
      ([, r]) =>
        r.origin?.replace(/\.git$/, '').endsWith(`/${forgeRepo}`) || r.origin?.replace(/\.git$/, '') === `git@github.com:${forgeRepo}`,
    )?.[0] ?? forgeRepo
  );
}
