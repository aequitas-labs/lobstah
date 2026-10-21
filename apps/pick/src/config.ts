import * as fs from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import * as os from 'node:os';
import { configPath, loadConfig, reviewSettings } from '@lobstah/core';
import { DEFAULT_MERGE_POLICY } from './types.js';
import type { MergePolicy } from './types.js';
import type { GithubConfig } from './sources/github.js';
import type { LinearConfig } from './sources/linear.js';

export interface PickupConfig {
  pollSecs: number;
  liveComment: boolean;
  /** Reviews-only setups do not run unrelated registered watch jobs. */
  watches: boolean;
  /** `[hooks.pickupNotify].command`: exec'd on every verb transition with LOBSTAH_* env vars; never blocks the loop. */
  notifyCommand?: string;
  github: Array<GithubConfig & { merge: MergePolicy }>;
  /** Review search credentials, independent of any opted-in pickup repo. */
  githubIdentity?: { identity: string; token: () => string };
  reviews?: { identity: string; token: () => string };
  legacyGithubDefaults?: boolean;
  linear?: LinearConfig;
  /**
   * Worktree pools issue dispatches run in (`[pickup].pools`): an issue for
   * repo R goes to the first listed pool whose repo is R. Review rounds are
   * follow-ups and keep their chain's worktree rule.
   */
  pools: string[];
}

/** "owner/name" from a GitHub origin URL in any of its usual shapes, else undefined. */
export function githubRepoFromOrigin(origin: string): string | undefined {
  const m =
    /^git@github\.com:(.+?)(?:\.git)?$/.exec(origin) ??
    /^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?$/.exec(origin) ??
    /^https:\/\/github\.com\/(.+?)(?:\.git)?\/?$/.exec(origin);
  const repo = m?.[1];
  return repo && repo.split('/').length === 2 ? repo : undefined;
}

/**
 * Token sources, in precedence order: tokenCommand (exec'd, cached briefly —
 * the fit for hourly-expiring GitHub App installation tokens), tokenFile
 * (read per call, supports rotation), tokenEnv (read per call, so a wrapper
 * can refresh it). Secrets never live in the config file itself.
 */
export function resolveTokenSource(section: Record<string, unknown>, label: string): () => string {
  const command = section.tokenCommand ? String(section.tokenCommand) : undefined;
  const file = section.tokenFile ? String(section.tokenFile) : undefined;
  const envName = section.tokenEnv ? String(section.tokenEnv) : undefined;

  if (command) {
    let cached: { token: string; at: number } | undefined;
    return () => {
      if (cached && Date.now() - cached.at < 5 * 60_000) return cached.token;
      const token = execSync(command, { encoding: 'utf8' }).trim();
      if (!token) throw new Error(`${label}: tokenCommand produced no output`);
      cached = { token, at: Date.now() };
      return token;
    };
  }
  if (file) {
    return () => {
      const token = fs.readFileSync(file.startsWith('~/') ? `${os.homedir()}/${file.slice(2)}` : file, 'utf8').trim();
      if (!token) throw new Error(`${label}: tokenFile ${file} is empty`);
      return token;
    };
  }
  if (envName) {
    return () => {
      const token = process.env[envName];
      if (!token) throw new Error(`${label}: no token in $${envName}`);
      return token;
    };
  }
  throw new Error(`${label}: configure one of tokenCommand, tokenFile, tokenEnv`);
}

function parsePickupPools(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('pickup.pools must be an array of pool names');
  const pools = loadConfig().pools;
  for (const name of raw) {
    if (!pools[String(name)]) throw new Error(`pickup.pools: unknown pool "${String(name)}" — add [pools.${String(name)}]`);
  }
  return raw.map(String);
}

/** The pool an issue dispatch for `repoKey` runs in: the first of `pools` that serves it. */
export function pickupPool(pools: string[], repoKey: string): string | undefined {
  const cfg = loadConfig().pools;
  return pools.find((name) => cfg[name]?.repo === repoKey);
}

/** The exact loops an installed pick process will run, before it is started. */
export function pickupPlan(cfg: PickupConfig = loadPickupConfig()): string[] {
  const config = loadConfig();
  const lines = Object.keys(config.repos).map((key) => {
    const gh = cfg.github.find((g) => g.key === key);
    const reviews = reviewSettings(config.reviews, key);
    return `${key}: issues ${gh && gh.issues !== false ? 'ON' : 'off'}, PR feedback ${gh && gh.prFeedback !== false ? 'ON' : 'off'}, merge ${gh?.merge.enabled ? 'ON' : 'off'}, reviews ${cfg.reviews ? `${reviews.mode} (${reviews.publish ? 'publish COMMENT' : 'draft'})` : 'off'}`;
  });
  for (const gh of cfg.github) if (!loadConfig().repos[gh.key]) lines.push(`${gh.key} (${gh.repo}): issues ${gh.issues === false ? 'off' : 'ON'}, PR feedback ${gh.prFeedback === false ? 'off' : 'ON'}, merge ${gh.merge.enabled ? 'ON' : 'off'}`);
  if (cfg.linear) lines.push('Linear: issue pickup ON');
  lines.push(cfg.reviews ? `review requests: ${cfg.reviews.identity}, mode ${loadConfig().reviews.mode}` : 'review requests: off');
  lines.push(`registered watch polling: ${cfg.watches ? 'ON' : 'off'}`);
  if (cfg.legacyGithubDefaults && cfg.github.length) lines.push('WARNING: legacy GitHub defaults enable issue and PR-feedback pickup; set issues and feedback explicitly');
  else if (cfg.github.some((g) => g.issues || g.prFeedback)) lines.push('WARNING: enabled issue/PR-feedback pickup can dispatch jobs and report status on PRs');
  return lines;
}

/** Pickup reads its own [pickup.*] sections from the shared config file. */
export function loadPickupConfig(): PickupConfig {
  const file = configPath();
  const raw = fs.existsSync(file) ? (parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  const p = (raw.pickup ?? {}) as Record<string, unknown>;
  const out: PickupConfig = {
    pollSecs: Number(p.pollSecs ?? 45),
    liveComment: p.liveComment === undefined ? true : Boolean(p.liveComment),
    watches: true,
    notifyCommand: loadConfig().hooks.pickupNotify?.command,
    github: [],
    pools: parsePickupPools(p.pools),
  };

  const gh = p.github as Record<string, unknown> | undefined;
  if (gh) {
    const token = resolveTokenSource({ tokenEnv: 'GITHUB_TOKEN', ...gh }, 'pickup.github');
    token(); // fail at startup, not mid-loop
    const identity = String(gh.identity ?? '');
    if (!identity) throw new Error('pickup.github requires identity');
    out.githubIdentity = { identity, token };
    const explicit = gh.issues !== undefined || gh.feedback !== undefined || gh.prFeedback !== undefined;
    out.legacyGithubDefaults = !explicit;
    const enabled = (value: unknown, label: string, fallback = !explicit): boolean => {
      if (value === undefined) return fallback;
      if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
      return value;
    };
    const shared = {
      identity,
      token,
      issues: enabled(gh.issues, 'pickup.github.issues'),
      prFeedback: enabled(gh.feedback ?? gh.prFeedback, 'pickup.github.feedback'),
      startLabel: String(gh.startLabel ?? 'lobstah'),
      claimedLabel: String(gh.claimedLabel ?? 'lobstah:claimed'),
    };
    const mergeBase = { ...DEFAULT_MERGE_POLICY, ...((gh.merge as Partial<MergePolicy>) ?? {}) };
    const overrides = (gh.overrides ?? {}) as Record<string, Record<string, unknown>>;

    if (gh.repo || gh.key) {
      // Single-repo mode: forge repo named explicitly.
      const single = { ...shared, repo: String(gh.repo ?? ''), key: String(gh.key ?? ''), merge: mergeBase };
      if (!single.repo || !single.key) throw new Error('pickup.github requires repo, key, and identity');
      out.github.push(single);
    } else {
      // Multi-repo mode: the [repos.*] table is the source of truth — every
      // repo that opted in with `pickup = true` and has a GitHub origin
      // becomes pickable, no forge vocabulary duplicated into [pickup].
      for (const [key, repo] of Object.entries(loadConfig().repos)) {
        if (!repo.pickup) continue;
        if (!repo.origin) throw new Error(`repos.${key} has pickup = true but no origin to derive the GitHub repo from`);
        const forgeRepo = githubRepoFromOrigin(repo.origin);
        if (!forgeRepo) throw new Error(`repos.${key} has pickup = true but origin "${repo.origin}" is not a GitHub URL`);
        const o = overrides[key] ?? {};
        out.github.push({
          ...shared,
          repo: forgeRepo,
          key,
          issues: enabled(o.issues, `pickup.github.overrides.${key}.issues`, shared.issues),
          prFeedback: enabled(o.feedback ?? o.prFeedback, `pickup.github.overrides.${key}.feedback`, shared.prFeedback),
          startLabel: o.startLabel ? String(o.startLabel) : shared.startLabel,
          claimedLabel: o.claimedLabel ? String(o.claimedLabel) : shared.claimedLabel,
          merge: { ...mergeBase, ...((o.merge as Partial<MergePolicy>) ?? {}) },
        });
      }
    }
  }

  const reviews = loadConfig().reviews;
  if (reviews.enabled) {
    const ownToken = reviews.tokenCommand || reviews.tokenEnv || reviews.tokenFile;
    const token = ownToken ? resolveTokenSource({ ...reviews }, 'reviews') : out.githubIdentity?.token ?? resolveTokenSource({ tokenCommand: 'gh auth token' }, 'reviews');
    let identity = reviews.identity ?? out.githubIdentity?.identity;
    if (!identity) {
      const me = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GH_TOKEN: token() } });
      identity = me.status === 0 ? me.stdout?.trim() : undefined;
      if (!identity) throw new Error('reviews: cannot derive GitHub login; run gh auth login or set [reviews].identity');
    }
    token();
    out.reviews = { identity, token };
  }

  const ln = p.linear as Record<string, unknown> | undefined;
  if (ln) {
    const token = resolveTokenSource({ tokenEnv: 'LINEAR_TOKEN', ...ln }, 'pickup.linear');
    token();
    const assignField = ln.assignField ? String(ln.assignField) : 'assignee';
    if (assignField !== 'assignee' && assignField !== 'delegate') {
      throw new Error(`pickup.linear.assignField must be "assignee" or "delegate", got "${assignField}"`);
    }
    out.linear = {
      token,
      assignField,
      startState: String(ln.startState ?? 'Todo'),
      startStateTypes: Array.isArray(ln.startStateTypes) ? ln.startStateTypes.map(String) : undefined,
      claimedState: String(ln.claimedState ?? 'In Progress'),
      doneState: String(ln.doneState ?? 'In Review'),
      route: (ln.route as Record<string, string>) ?? {},
    };
  }

  if (p.watches !== undefined && typeof p.watches !== 'boolean') throw new Error('pickup.watches must be a boolean');
  out.watches = p.watches === undefined ? !(out.reviews && !out.linear && !out.github.some((g) => g.issues || g.prFeedback || g.merge.enabled)) : p.watches;
  return out;
}
