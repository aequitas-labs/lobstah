import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { parse } from 'smol-toml';
import * as os from 'node:os';
import { configPath, loadConfig } from '@lobstah/core';
import { DEFAULT_MERGE_POLICY } from './types.js';
import type { MergePolicy } from './types.js';
import type { GithubConfig } from './sources/github.js';
import type { LinearConfig } from './sources/linear.js';

export interface PickupConfig {
  pollSecs: number;
  /** Exec'd on every verb transition with LOBSTAH_* env vars; never blocks the loop. */
  notifyCommand?: string;
  github: Array<GithubConfig & { merge: MergePolicy }>;
  linear?: LinearConfig;
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

/** Pickup reads its own [pickup.*] sections from the shared config file. */
export function loadPickupConfig(): PickupConfig {
  const file = configPath();
  const raw = fs.existsSync(file) ? (parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  const p = (raw.pickup ?? {}) as Record<string, unknown>;
  const out: PickupConfig = {
    pollSecs: Number(p.pollSecs ?? 45),
    notifyCommand: p.notifyCommand ? String(p.notifyCommand) : undefined,
    github: [],
  };

  const gh = p.github as Record<string, unknown> | undefined;
  if (gh) {
    const token = resolveTokenSource({ tokenEnv: 'GITHUB_TOKEN', ...gh }, 'pickup.github');
    token(); // fail at startup, not mid-loop
    const identity = String(gh.identity ?? '');
    if (!identity) throw new Error('pickup.github requires identity');
    const shared = {
      identity,
      token,
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
          startLabel: o.startLabel ? String(o.startLabel) : shared.startLabel,
          claimedLabel: o.claimedLabel ? String(o.claimedLabel) : shared.claimedLabel,
          merge: { ...mergeBase, ...((o.merge as Partial<MergePolicy>) ?? {}) },
        });
      }
      if (out.github.length === 0) {
        throw new Error(
          'pickup.github has no repo — multi-repo mode needs at least one [repos.<key>] with pickup = true and a GitHub origin',
        );
      }
    }
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

  return out;
}
