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
  /**
   * Repo-relative paths whose untracked files do not make a worktree dirty
   * for reuse by a follow-up (build output, caches, scratch notes).
   */
  scratch?: string[];
  /** Override the headless runner's remote-preservation policies. */
  pushEarly?: boolean;
  draftPr?: boolean;
  checkpointOnStop?: boolean;
}

export interface LimitsConfig {
  maxConcurrent: number;
  choreConcurrent: number;
  wedgeThresholdSecs: number;
  maxRestartAttempts: number;
  wallClockSecs: number;
  /** Hard ceiling for progress-extended wall-clock time (default 4× wallClockSecs). */
  maxWallClockSecs?: number;
  pushEarly: boolean;
  draftPr: boolean;
  checkpointOnStop: boolean;
  /**
   * How long a turn that ends without a report is held open while background
   * work the worker started is still running. The harness wakes the worker
   * when that work settles; past this window the worker is asked to report.
   */
  backgroundWaitSecs: number;
  choreRetentionDays: number;
  attachmentMaxBytes: number;
  /**
   * The daemon culls finished work dispatches (done and failed) older than
   * this many days, with their worktrees and state. 0 turns it off.
   */
  retentionDays: number;
  /**
   * Free space, in GB, the worktrees volume must have before the daemon
   * claims work that creates a worktree. 0 turns the guard off.
   */
  minFreeGB: number;
  /**
   * A follow-up reuses the worktree of the newest dispatch in its chain when
   * that worktree is clean and no other dispatch is using it. false
   * allocates a fresh worktree for every dispatch.
   */
  reuseWorktree: boolean;
  /**
   * When a PR watch records a merge, the daemon's next cull pass removes the
   * worktree of the dispatch chain that owns the PR, if every dispatch in it
   * is finished, the worktree is clean, and its HEAD is on the remote.
   */
  releaseOnMerge: boolean;
}

export interface SoakConfig {
  /** How long a fresh park heartbeat holds unaddressed matching bait for a soaking session. */
  deferSecs: number;
  /** Heartbeat age past which a registration is a ghost trap and gets swept. */
  ttlSecs: number;
  /**
   * The post-tool hook (`lobstah soak beat`) refreshes a trap's liveness and
   * writes its catch's activity. False makes the hook do nothing.
   */
  beat: boolean;
  /**
   * How long a trap whose catch last reported `paused` is kept out of the
   * ghost sweep, from the report. `report paused --until` overrides it.
   */
  pausedTtlSecs: number;
}

export interface HelmConfig {
  /** Heartbeat age past which a helm registration is stale and claimable without --take. */
  ttlSecs: number;
  /** Minimum seconds between haul-delivered digests for a helm session. */
  reportSecs: number;
  /** Stop hook behavior: arm a background watcher or block in the hook. */
  park?: 'arm' | 'block';
  /** Arm mode: seconds the Stop hook polls for a watcher that is still starting before it blocks. */
  armGraceSecs: number;
}

export interface WatchConfig {
  /**
   * The most CI-fix (continuation) dispatches one watch cycle may fork.
   * Watches over the cap are held, listed in tend, and fork nothing until
   * `lobstah watch release`.
   */
  maxForksPerCycle: number;
}

export interface GlassConfig {
  port: number;
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
  glass: GlassConfig;
  watch: WatchConfig;
  grounds: Record<string, GroundsConfig>;
  /** Exec'd on wake-worthy status transitions with LOBSTAH_* env vars. */
  notifyCommand?: string;
  /** Verbs that fire notifyCommand. Default: needs-decision, blocked, done, failed. */
  notifyVerbs?: string[];
  /** Re-fire an unanswered attention state every this many seconds (0 disables). Default 900. */
  remindSecs?: number;
  /** Which attention kinds tend (and so the pet and the glass) walk. Default DEFAULT_ATTENTION_KINDS. */
  attentionKinds: AttentionKind[];
}

/**
 * The configurable attention kinds (docs/vocabulary.md, "Attention contract").
 * Level-triggered: each stands until its clear condition, unlike notifyVerbs,
 * which fire once per transition.
 */
export const ATTENTION_KINDS = ['question', 'landed', 'pr:draft', 'pr:review', 'pr:checks', 'pr:conflict', 'pr:ready'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
/** Everything but landed, which is opt-in: the digest already carries landings. */
export const DEFAULT_ATTENTION_KINDS: AttentionKind[] = ['question', 'pr:draft', 'pr:review', 'pr:checks', 'pr:conflict', 'pr:ready'];

function parseAttentionKinds(raw: unknown): AttentionKind[] {
  if (raw === undefined) return [...DEFAULT_ATTENTION_KINDS];
  if (!Array.isArray(raw)) {
    throw new Error(`attentionKinds must be an array of kinds (${ATTENTION_KINDS.join(', ')}) in ${configPath()}`);
  }
  for (const k of raw) {
    if (!(ATTENTION_KINDS as readonly unknown[]).includes(k)) {
      throw new Error(`attentionKinds: unknown kind "${String(k)}" in ${configPath()} — valid kinds: ${ATTENTION_KINDS.join(', ')}`);
    }
  }
  return [...new Set(raw as AttentionKind[])];
}

export const DEFAULT_SOAK: SoakConfig = {
  deferSecs: 90,
  ttlSecs: 1800,
  beat: true,
  pausedTtlSecs: 86400,
};

export const DEFAULT_HELM: HelmConfig = {
  ttlSecs: 1800,
  reportSecs: 900,
  armGraceSecs: 5,
};

export const DEFAULT_GLASS: GlassConfig = { port: 4949 };

export const DEFAULT_WATCH: WatchConfig = { maxForksPerCycle: 3 };

export const DEFAULT_LIMITS: LimitsConfig = {
  maxConcurrent: 2,
  choreConcurrent: 1,
  wedgeThresholdSecs: 600,
  maxRestartAttempts: 2,
  wallClockSecs: 3600,
  pushEarly: true,
  draftPr: true,
  checkpointOnStop: true,
  backgroundWaitSecs: 1800,
  choreRetentionDays: 7,
  attachmentMaxBytes: 25 * 1024 * 1024,
  retentionDays: 0,
  minFreeGB: 0,
  reuseWorktree: true,
  releaseOnMerge: false,
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
      scratch: Array.isArray(r.scratch) ? r.scratch.map(String) : undefined,
      pushEarly: r.pushEarly === undefined ? undefined : Boolean(r.pushEarly),
      draftPr: r.draftPr === undefined ? undefined : Boolean(r.draftPr),
      checkpointOnStop: r.checkpointOnStop === undefined ? undefined : Boolean(r.checkpointOnStop),
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
    glass: { ...DEFAULT_GLASS, ...((raw.glass as Partial<GlassConfig>) ?? {}) },
    watch: { ...DEFAULT_WATCH, ...((raw.watch as Partial<WatchConfig>) ?? {}) },
    grounds,
    notifyCommand: raw.notifyCommand ? String(raw.notifyCommand) : undefined,
    notifyVerbs: Array.isArray(raw.notifyVerbs) ? raw.notifyVerbs.map(String) : undefined,
    remindSecs: raw.remindSecs !== undefined ? Number(raw.remindSecs) : undefined,
    attentionKinds: parseAttentionKinds(raw.attentionKinds),
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
