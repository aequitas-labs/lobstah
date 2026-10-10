import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { parseBackendLocation } from './backend.js';
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
  /**
   * Check names that fail until a person approves. They never start a PR
   * repair or a CI-fix continuation. `*` matches any run of characters.
   */
  humanGateChecks?: string[];
  /**
   * Markdown appended to the briefs lobstah writes for this repo, per kind
   * (`[repos.<key>.briefHooks]`). The text is the repo's own; lobstah does
   * not read it.
   */
  briefHooks?: BriefHooks;
  /**
   * Extra gitignore-style patterns a pool reset keeps (`[repos.<key>].poolKeep`),
   * on top of DEFAULT_POOL_KEEP. Untracked files that match no pattern are
   * removed when a pool worktree is reset for a new dispatch.
   */
  poolKeep?: string[];
}

/** What a pool dispatch does when every pool worktree is taken. */
export type PoolOverflow = 'headless' | 'queue';

/**
 * A pool (`[pools.<name>]`): pre-warmed worktrees for one repo, with no
 * session attached. A dispatch with `pool` takes a free one, resets it to a
 * fresh branch from trunk, and starts a new headless session there.
 */
export interface PoolConfig {
  /** The repo key the pool's worktrees check out. */
  repo: string;
  /** How many worktrees the daemon keeps warm. */
  size: number;
  /**
   * `headless` (default): a dispatch that finds the pool full runs in a
   * normal cold worktree. `queue`: it stays queued until a pool worktree is
   * free.
   */
  overflow: PoolOverflow;
}

/** Pool names name directories: letters, digits, `-` and `_`. */
const POOL_NAME = /^[A-Za-z0-9_-]+$/;

function parsePools(raw: unknown, repos: Record<string, RepoConfig>): Record<string, PoolConfig> {
  const out: Record<string, PoolConfig> = {};
  if (raw === undefined) return out;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`[pools] must be a table of pools in ${configPath()}`);
  for (const [name, p] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    const where = `[pools.${name}] in ${configPath()}`;
    if (!POOL_NAME.test(name)) throw new Error(`${where}: a pool name may use letters, digits, "-" and "_" only`);
    const repo = String(p?.repo ?? '');
    if (!repos[repo]) throw new Error(`${where}: repo "${repo}" is not a configured [repos.<key>]`);
    const size = p.size ?? 1;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) throw new Error(`${where}: size must be a positive integer`);
    const overflow = p.overflow ?? 'headless';
    if (overflow !== 'headless' && overflow !== 'queue') throw new Error(`${where}: overflow must be "headless" or "queue"`);
    out[name] = { repo, size, overflow };
  }
  return out;
}

/** The kinds of brief lobstah writes itself, and `all` for every one of them. */
export const BRIEF_KINDS = ['conflict', 'checks', 'review', 'ciFix', 'rebase'] as const;
export type BriefKind = (typeof BRIEF_KINDS)[number];
export type BriefHooks = Partial<Record<BriefKind | 'all', string>>;

function parseBriefHooks(raw: unknown): BriefHooks | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: BriefHooks = {};
  for (const kind of [...BRIEF_KINDS, 'all'] as const) {
    const text = (raw as Record<string, unknown>)[kind];
    if (typeof text === 'string' && text.trim()) out[kind] = text.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A generated brief with the repo's hooks for its kind appended: that
 * kind's text, then `all`. The brief is unchanged when the repo has none.
 */
export function withBriefHooks(brief: string, repo: Pick<RepoConfig, 'briefHooks'> | undefined, kind: BriefKind): string {
  const hooks = [repo?.briefHooks?.[kind], repo?.briefHooks?.all].filter((t): t is string => !!t);
  return hooks.length ? `${brief}\n\n${hooks.join('\n\n')}` : brief;
}

export interface LimitsConfig {
  /** Maximum daemon-spawned work runners; trap catches use their own sessions. */
  maxConcurrent: number;
  /** Maximum daemon-spawned chore runners; trap catches use no slots. */
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
  /**
   * After the worker reports `done` or `failed` at turn end, how long the
   * runner waits for the harness to close its event stream. Past this, the
   * runner stops the harness and its process group, and finishes.
   */
  exitGraceSecs: number;
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
  /** Grace after a claim before an absent worker report raises a helm notice. */
  claimIdleNoticeSecs: number;
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
  /**
   * How long after a trap signs off its address is held: messages to it wait
   * for a re-soak of the same worktree instead of bouncing, and addressed
   * work raises no bait-orphaned notice.
   */
  signOffGraceSecs: number;
  /**
   * The terminal app a thrown trap opens in: `terminal` (Terminal.app) or
   * `iterm` (iTerm2). A trap's roster profile overrides it. Unset, a throw
   * uses the app the trap last signed on from, else Terminal.app.
   */
  terminal?: 'terminal' | 'iterm';
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
  /** Repair dispatch-owned PRs before raising check or conflict attention. */
  autoRepair: boolean;
  /** Repair PR merge conflicts when autoRepair is on. */
  conflicts: boolean;
  /** Repair failed PR checks when autoRepair is on. */
  checks: boolean;
  /** Maximum repair follow-ups on one PR head sha. */
  maxRepairsPerPr: number;
  /**
   * Consecutive repairs of one PR that made no merge progress (the PR needs
   * a repair again after one finished, with no other push between) before
   * lobstah stops repairing it and raises attention. Default 2.
   */
  maxRepairsWithoutProgress: number;
  /**
   * Seconds the PR's head, its base branch's head, and its failing checks
   * must stay unchanged before a repair is queued.
   */
  repairSettleSecs: number;
  /** Minimum time between daemon repairs of one PR, from the previous repair's end, across heads. */
  repairCooldownSecs: number;
  /** Maximum time a daemon repair waits for its owning trap. */
  repairTrapWaitSecs: number;
}

export interface GlassConfig {
  port: number;
}

/** A named territory: the subset of configured repos one helm oversees. */
export interface GroundsConfig {
  repos: string[];
  /** Omitted: local files. Otherwise an entry in wharves, never a global mode. */
  wharf?: string;
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
  wharves?: Record<string, import('./backend-model.js').BackendLocation>;
  /** Worktree pools for headless dispatches (`[pools.<name>]`). */
  pools: Record<string, PoolConfig>;
  /** Exec'd on wake-worthy status transitions with LOBSTAH_* env vars. */
  notifyCommand?: string;
  /** Verbs that fire notifyCommand. Default: needs-decision, blocked, done, failed. */
  notifyVerbs?: string[];
  /** Re-fire an unanswered attention state every this many seconds (0 disables). Default 900. */
  remindSecs?: number;
  /** Continuous-ready seconds before pr:ready stands; 0 disables settling. Default 600. */
  readySettleSecs: number;
  /** Which attention kinds tend (and so the pet and the glass) walk. Default DEFAULT_ATTENTION_KINDS. */
  attentionKinds: AttentionKind[];
}

/**
 * The configurable attention kinds (docs/vocabulary.md, "Attention contract").
 * Level-triggered: each stands until its clear condition, unlike notifyVerbs,
 * which fire once per transition.
 */
export const ATTENTION_KINDS = ['question', 'decision', 'landed', 'pr:draft', 'pr:review', 'pr:checks', 'pr:conflict', 'pr:ready', 'report', 'stack-ready'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
/** Human-actionable conditions; drafts and landed catches are opt-in. */
export const DEFAULT_ATTENTION_KINDS: AttentionKind[] = ['question', 'decision', 'pr:ready', 'pr:review', 'pr:conflict', 'pr:checks'];

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

function parseSoak(raw: unknown): SoakConfig {
  const soak: SoakConfig = { ...DEFAULT_SOAK, ...((raw as Partial<SoakConfig>) ?? {}) };
  if (soak.terminal !== undefined && soak.terminal !== 'terminal' && soak.terminal !== 'iterm') {
    throw new Error(`soak.terminal: unknown terminal "${String(soak.terminal)}" in ${configPath()} — use "terminal" or "iterm"`);
  }
  return soak;
}

export const DEFAULT_SOAK: SoakConfig = {
  deferSecs: 90,
  claimIdleNoticeSecs: 180,
  ttlSecs: 1800,
  beat: true,
  pausedTtlSecs: 86400,
  signOffGraceSecs: 600,
};

export const DEFAULT_HELM: HelmConfig = {
  ttlSecs: 1800,
  reportSecs: 900,
  armGraceSecs: 5,
};

export const DEFAULT_GLASS: GlassConfig = { port: 4949 };

export const DEFAULT_WATCH: WatchConfig = { maxForksPerCycle: 3, autoRepair: true, conflicts: true, checks: true, maxRepairsPerPr: 2, maxRepairsWithoutProgress: 2, repairSettleSecs: 600, repairCooldownSecs: 0, repairTrapWaitSecs: 600 };

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
  exitGraceSecs: 30,
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
  const watch = { ...DEFAULT_WATCH, ...((raw.watch as Partial<WatchConfig>) ?? {}) };
  if (typeof watch.repairCooldownSecs !== 'number' || !Number.isFinite(watch.repairCooldownSecs) || watch.repairCooldownSecs < 0) {
    throw new Error(`[watch].repairCooldownSecs must be a non-negative number in ${configPath()}`);
  }
  const readySettleSecs = raw.readySettleSecs ?? 600;
  if (typeof readySettleSecs !== 'number' || !Number.isFinite(readySettleSecs) || readySettleSecs < 0) {
    throw new Error(`readySettleSecs must be a non-negative number in ${configPath()}`);
  }
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
      humanGateChecks: Array.isArray(r.humanGateChecks) ? r.humanGateChecks.map(String).filter(Boolean) : undefined,
      briefHooks: parseBriefHooks(r.briefHooks),
      poolKeep: Array.isArray(r.poolKeep) ? r.poolKeep.map(String).filter(Boolean) : undefined,
    };
  }
  const groundsRaw = (raw.grounds ?? {}) as Record<string, Record<string, unknown>>;
  const wharves: Record<string, import('./backend-model.js').BackendLocation> = {};
  for (const [name, value] of Object.entries((raw.wharves ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('invalid wharf name');
    wharves[name] = parseBackendLocation({ ...value, kind: 'wharf' })!;
  }
  const grounds: Record<string, GroundsConfig> = {};
  for (const [key, g] of Object.entries(groundsRaw)) {
    if (g.wharf !== undefined && (typeof g.wharf !== 'string' || !wharves[g.wharf])) throw new Error(`grounds ${key}: unknown wharf`);
    grounds[key] = { repos: Array.isArray(g.repos) ? g.repos.map(String) : [], ...(g.wharf ? { wharf: String(g.wharf) } : {}) };
  }
  return {
    repos,
    harness: (raw.harness as HarnessDefaults) ?? {},
    limits: { ...DEFAULT_LIMITS, ...((raw.limits as Partial<LimitsConfig>) ?? {}) },
    soak: parseSoak(raw.soak),
    helm: { ...DEFAULT_HELM, ...((raw.helm as Partial<HelmConfig>) ?? {}) },
    glass: { ...DEFAULT_GLASS, ...((raw.glass as Partial<GlassConfig>) ?? {}) },
    watch,
    grounds,
    wharves,
    pools: parsePools(raw.pools, repos),
    notifyCommand: raw.notifyCommand ? String(raw.notifyCommand) : undefined,
    notifyVerbs: Array.isArray(raw.notifyVerbs) ? raw.notifyVerbs.map(String) : undefined,
    remindSecs: raw.remindSecs !== undefined ? Number(raw.remindSecs) : undefined,
    readySettleSecs,
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
