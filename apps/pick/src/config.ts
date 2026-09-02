import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { parse } from 'smol-toml';
import * as os from 'node:os';
import { configPath } from '@lobstah/core';
import { DEFAULT_MERGE_POLICY } from './types.js';
import type { MergePolicy } from './types.js';
import type { GithubConfig } from './sources/github.js';
import type { LinearConfig } from './sources/linear.js';

export interface PickupConfig {
  pollSecs: number;
  /** Exec'd on every verb transition with LOBSTAH_* env vars; never blocks the loop. */
  notifyCommand?: string;
  github?: GithubConfig & { merge: MergePolicy };
  linear?: LinearConfig;
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
  };

  const gh = p.github as Record<string, unknown> | undefined;
  if (gh) {
    const token = resolveTokenSource({ tokenEnv: 'GITHUB_TOKEN', ...gh }, 'pickup.github');
    token(); // fail at startup, not mid-loop
    out.github = {
      repo: String(gh.repo ?? ''),
      key: String(gh.key ?? ''),
      identity: String(gh.identity ?? ''),
      token,
      startLabel: String(gh.startLabel ?? 'lobstah'),
      claimedLabel: String(gh.claimedLabel ?? 'lobstah:claimed'),
      merge: { ...DEFAULT_MERGE_POLICY, ...((gh.merge as Partial<MergePolicy>) ?? {}) },
    };
    if (!out.github.repo || !out.github.key || !out.github.identity) {
      throw new Error('pickup.github requires repo, key, and identity');
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
