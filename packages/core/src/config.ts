import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import type { Descriptor, DispatchLimits } from './types.js';
import { lobstahHome } from './paths.js';

export interface HarnessDefaults {
  default?: string;
  model?: string;
  effort?: string;
}

export interface RepoConfig {
  path: string;
  origin?: string;
  trunk: string;
  setup?: string[];
  env?: Record<string, string>;
  harness?: HarnessDefaults;
  /** Opt this repo into tracker pickup (multi-repo [pickup.github] mode). */
  pickup?: boolean;
}

export interface LimitsConfig {
  maxConcurrent: number;
  choreConcurrent: number;
  wedgeThresholdSecs: number;
  maxRestartAttempts: number;
  wallClockSecs: number;
  choreRetentionDays: number;
}

export interface SoakConfig {
  /** How long a fresh park heartbeat holds unaddressed matching bait for a soaking session. */
  deferSecs: number;
  /** Heartbeat age past which a registration is a ghost trap and gets swept. */
  ttlSecs: number;
}

export interface HelmConfig {
  /** Heartbeat age past which a helm registration is stale and claimable without --take. */
  ttlSecs: number;
  /** Minimum seconds between haul-delivered digests for a helm session. */
  reportSecs: number;
}

/** A named territory: the subset of configured repos one helm oversees. */
export interface GroundsConfig {
  repos: string[];
}

export interface Config {
  repos: Record<string, RepoConfig>;
  harness: HarnessDefaults;
  limits: LimitsConfig;
  soak: SoakConfig;
  helm: HelmConfig;
  grounds: Record<string, GroundsConfig>;
  /** Exec'd on wake-worthy status transitions with LOBSTAH_* env vars. */
  notifyCommand?: string;
  /** Verbs that fire notifyCommand. Default: needs-decision, blocked, done, failed. */
  notifyVerbs?: string[];
  /** Re-fire an unanswered attention state every this many seconds (0 disables). Default 900. */
  remindSecs?: number;
}

export const DEFAULT_SOAK: SoakConfig = {
  deferSecs: 90,
  ttlSecs: 1800,
};

export const DEFAULT_HELM: HelmConfig = {
  ttlSecs: 1800,
  reportSecs: 900,
};

export const DEFAULT_LIMITS: LimitsConfig = {
  maxConcurrent: 2,
  choreConcurrent: 1,
  wedgeThresholdSecs: 600,
  maxRestartAttempts: 2,
  wallClockSecs: 3600,
  choreRetentionDays: 7,
};

export function configPath(): string {
  return path.join(lobstahHome(), 'config.toml');
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export function loadConfig(): Config {
  const file = configPath();
  const raw = fs.existsSync(file) ? (parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  const reposRaw = (raw.repos ?? {}) as Record<string, Record<string, unknown>>;
  const repos: Record<string, RepoConfig> = {};
  for (const [key, r] of Object.entries(reposRaw)) {
    repos[key] = {
      path: expandHome(String(r.path ?? '')),
      origin: r.origin ? String(r.origin) : undefined,
      trunk: String(r.trunk ?? 'main'),
      setup: Array.isArray(r.setup) ? r.setup.map(String) : undefined,
      env: (r.env as Record<string, string>) ?? undefined,
      harness: (r.harness as HarnessDefaults) ?? undefined,
      pickup: r.pickup === undefined ? undefined : Boolean(r.pickup),
    };
  }
  const groundsRaw = (raw.grounds ?? {}) as Record<string, Record<string, unknown>>;
  const grounds: Record<string, GroundsConfig> = {};
  for (const [key, g] of Object.entries(groundsRaw)) {
    grounds[key] = { repos: Array.isArray(g.repos) ? g.repos.map(String) : [] };
  }
  return {
    repos,
    harness: (raw.harness as HarnessDefaults) ?? {},
    limits: { ...DEFAULT_LIMITS, ...((raw.limits as Partial<LimitsConfig>) ?? {}) },
    soak: { ...DEFAULT_SOAK, ...((raw.soak as Partial<SoakConfig>) ?? {}) },
    helm: { ...DEFAULT_HELM, ...((raw.helm as Partial<HelmConfig>) ?? {}) },
    grounds,
    notifyCommand: raw.notifyCommand ? String(raw.notifyCommand) : undefined,
    notifyVerbs: Array.isArray(raw.notifyVerbs) ? raw.notifyVerbs.map(String) : undefined,
    remindSecs: raw.remindSecs !== undefined ? Number(raw.remindSecs) : undefined,
  };
}

export interface ResolvedDispatch {
  harness: string;
  model?: string;
  effort?: string;
  limits: DispatchLimits;
  env: Record<string, string>;
  flags: string[];
}

/** Precedence chain: descriptor > repo config > global config > adapter default. */
export function resolveDispatch(d: Descriptor, cfg: Config): ResolvedDispatch {
  const repo = cfg.repos[d.repo];
  if (!repo) throw new Error(`unknown repo key "${d.repo}" — add it to ${configPath()}`);
  const rh = repo.harness ?? {};
  const gh = cfg.harness;
  return {
    harness: d.harness ?? rh.default ?? gh.default ?? 'claude',
    model: d.model ?? rh.model ?? gh.model,
    effort: d.effort ?? rh.effort ?? gh.effort,
    limits: {
      wallClockSecs: cfg.limits.wallClockSecs,
      ...(d.limits ?? {}),
    },
    env: { ...(repo.env ?? {}), ...(d.env ?? {}) },
    flags: d.flags ?? [],
  };
}
