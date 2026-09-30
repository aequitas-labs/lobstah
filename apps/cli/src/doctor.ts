import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import {
  classifyGhError,
  configPath,
  executorPath,
  firstMeaningfulLine,
  formatGB,
  GB,
  loadConfig,
  listTraps,
  trapLabel,
  lobstahHome,
  lobstahVersion,
  onPath,
  packagePresent,
  readHold,
  statfsFreeBytes,
  slotUsage,
  worktreesDir,
  readKeptWorktrees,
} from '@lobstah/core';
import type { Config, FreeBytesReader, RepoConfig } from '@lobstah/core';
import { githubRepoFromOrigin, loadPickupConfig } from '@lobstah/pick';
import { planPressureCull } from './cull.js';
import { parkedSummary } from './parked-view.js';
import { installedClaudePlugin, installedCodexPlugin, pluginDrift, UPDATE_COMMAND, versionGap } from './plugin-version.js';
import { glassPort, glassUrl, probeGlass } from './glass-lifecycle.js';
import { serviceFile } from './service.js';
import { liveRepairer, repairChores, waitingRepairs } from './pr-repair.js';
import { petRow } from './pet.js';
import { claudeHooks, codexHooks, hookRow, listenerRow } from './hook-readiness.js';

export interface DoctorRow {
  check: string;
  /** skip: the check does not apply here (e.g. no plugin installed); never fails the run. */
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
}

const HEARTBEAT_STALE_MS = 90_000;

function git(repoPath: string, ...args: string[]): { ok: boolean; out: string } {
  const res = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' });
  return { ok: res.status === 0, out: (res.stdout ?? '').trim() || (res.stderr ?? '').trim() };
}

/**
 * Everything a fresh install trips over, checked in one pass: binaries,
 * config, repos, harnesses, and whether the daemon is actually alive.
 * Read-only except tokenCommand execution (verifying a token source mints
 * is the point of checking it).
 */
/**
 * One row per harness plugin: the version the harness actually loads versus
 * the CLI's, compared on the full version (plugin versions track the CLI).
 * Any gap is a warning: a patch gap never fails the run, and neither does a
 * minor or major gap.
 */
export function pluginRows(cliVersion: string, opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): DoctorRow[] {
  const rows: DoctorRow[] = [];
  // A workspace/dev build reports 0.0.0-dev by design: nothing to compare against.
  const devCli = cliVersion.startsWith('0.0.0');
  for (const [harness, find] of [
    ['claude', installedClaudePlugin],
    ['codex', installedCodexPlugin],
  ] as const) {
    const check = `plugin ${harness}`;
    const p = find(opts);
    if (!p) {
      rows.push({ check, status: 'skip', detail: 'not installed' });
      continue;
    }
    if (devCli) {
      rows.push({
        check,
        status: 'skip',
        detail: `v${p.version} installed; this CLI is a dev build (v${cliVersion}) — nothing to compare`,
      });
      continue;
    }
    const drift = pluginDrift(p.version, cliVersion);
    const gap = versionGap(p.version, cliVersion);
    rows.push(
      drift === 'match'
        ? { check, status: 'ok', detail: `v${p.version} matches CLI v${cliVersion} (${p.root})` }
        : {
            check,
            status: 'warn',
            detail: `plugin v${p.version} is ${gap ? `a ${gap} version ` : ''}${drift === 'ahead' ? 'ahead of' : drift} CLI v${cliVersion} — ${drift === 'behind' ? UPDATE_COMMAND[harness] : 'update the CLI: npm i -g lobstah'} (${p.root})`,
          },
    );
  }
  return rows;
}

/** Runs `gh api <path>` (a GET) and returns the parsed body or gh's first error line. */
export type GhApi = (apiPath: string) => { ok: true; out: string } | { ok: false; err: string };

export const ghApi: GhApi = (apiPath) => {
  const res = spawnSync('gh', ['api', '--method', 'GET', apiPath], { encoding: 'utf8', timeout: 30_000 });
  if (res.error) return { ok: false, err: `gh: ${res.error.message}` };
  if (res.status !== 0) return { ok: false, err: firstMeaningfulLine(res.stderr, res.stdout) ?? `gh exited ${res.status}` };
  return { ok: true, out: res.stdout };
};

/**
 * The `github` rows: which identity gh runs as, then one read-only probe per
 * configured GitHub origin — can it read pull requests, contents, and check
 * results? Every call is a GET. See docs/github.md for the permissions.
 */
export function githubRows(
  repos: Array<{ key: string; forgeRepo: string; trunk: string }>,
  api: GhApi = ghApi,
  hasGh = onPath('gh'),
): DoctorRow[] {
  // No GitHub repo configured: nothing to probe, and no network call to make.
  if (repos.length === 0) return [{ check: 'github', status: 'skip', detail: 'no configured repo has a GitHub origin' }];
  if (!hasGh) return [{ check: 'github', status: 'warn', detail: 'gh not on PATH — PR watches and pickup cannot reach GitHub' }];
  const rows: DoctorRow[] = [];
  const user = api('user');
  if (user.ok) {
    let login = '?';
    try {
      login = (JSON.parse(user.out) as { login?: string }).login ?? '?';
    } catch {
      /* keep ? */
    }
    rows.push({ check: 'github', status: 'ok', detail: `gh runs as user ${login}` });
  } else {
    // An App installation token cannot read /user, but can list its repositories.
    const inst = api('installation/repositories?per_page=1');
    if (inst.ok) {
      let n = '?';
      try {
        n = String((JSON.parse(inst.out) as { total_count?: number }).total_count ?? '?');
      } catch {
        /* keep ? */
      }
      rows.push({ check: 'github', status: 'ok', detail: `gh runs as a GitHub App installation (${n} repos)` });
    } else {
      const cls = classifyGhError(user.err);
      rows.push({ check: 'github', status: 'fail', detail: `gh identity unknown: ${user.err}${cls.remedy ? ` — ${cls.remedy}` : ''}` });
      return rows;
    }
  }
  for (const r of repos) {
    const probes: Array<[keyof typeof PROBE_PERMISSION, string]> = [
      ['pull requests', `repos/${r.forgeRepo}/pulls?state=all&per_page=1`],
      ['contents', `repos/${r.forgeRepo}/commits?per_page=1`],
      ['checks', `repos/${r.forgeRepo}/commits/${encodeURIComponent(r.trunk)}/check-runs?per_page=1`],
    ];
    const results = probes.map(([what, p]) => ({ what, res: api(p) }));
    const denied = results.filter((x) => !x.res.ok);
    const detail = results.map((x) => `${x.what} ${x.res.ok ? 'readable' : 'NOT readable'}`).join(', ');
    if (denied.length === 0) {
      rows.push({ check: `github ${r.key}`, status: 'ok', detail: `${r.forgeRepo}: ${detail}` });
      continue;
    }
    const first = denied[0]!;
    const err = first.res.ok ? '' : first.res.err;
    const cls = classifyGhError(err);
    // A forbidden read names the permission for that probe, not the generic Checks one.
    const forbidden = cls.kind === 'checks-permission' || cls.kind === 'permission' || /HTTP 403/.test(err);
    const remedy = forbidden ? `grant the GitHub App \`${PROBE_PERMISSION[first.what]}: read\`; see docs/github.md` : cls.remedy;
    rows.push({
      check: `github ${r.key}`,
      status: 'warn',
      detail: `${r.forgeRepo}: ${detail} — ${first.what}: ${err}${remedy ? ` — ${remedy}` : ''}`,
    });
  }
  return rows;
}

const PROBE_PERMISSION = { 'pull requests': 'Pull requests', contents: 'Contents', checks: 'Checks' } as const;

/** Configured repos with a GitHub origin (config's origin, else the checkout's `origin` remote). */
export function githubRepos(repos: Record<string, RepoConfig>): Array<{ key: string; forgeRepo: string; trunk: string }> {
  const out: Array<{ key: string; forgeRepo: string; trunk: string }> = [];
  for (const [key, r] of Object.entries(repos)) {
    const origin = r.origin ?? (fs.existsSync(r.path) ? git(r.path, 'remote', 'get-url', 'origin').out : '');
    const forgeRepo = origin ? githubRepoFromOrigin(origin) : undefined;
    if (forgeRepo) out.push({ key, forgeRepo, trunk: r.trunk });
  }
  return out;
}

/**
 * The `disk` row: free space on the worktrees volume, the limits in force,
 * and how many finished worktrees a cull could remove (and the oldest one's
 * age). Warns while free space is below `[limits].minFreeGB`.
 */
export function diskRow(cfg: Config, freeBytes: FreeBytesReader = statfsFreeBytes, now = Date.now()): DoctorRow {
  const dir = worktreesDir();
  let free: number | undefined;
  try {
    free = freeBytes(fs.existsSync(dir) ? dir : lobstahHome());
  } catch {
    free = undefined;
  }
  const { minFreeGB, retentionDays } = cfg.limits;
  const cullable = fs.existsSync(dir) ? planPressureCull(now) : [];
  const oldest = cullable.reduce((max, i) => Math.max(max, i.ageDays), 0);
  const parts = [
    free === undefined ? 'free space unreadable' : `${formatGB(free)} free on ${dir}`,
    `minFreeGB ${minFreeGB > 0 ? minFreeGB : 'off'}`,
    `retentionDays ${retentionDays > 0 ? retentionDays : 'off'}`,
    cullable.length > 0 ? `${cullable.length} cullable worktree(s), oldest ${oldest}d` : 'no cullable worktrees',
  ];
  parts.push(`releaseOnMerge ${cfg.limits.releaseOnMerge ? 'on' : 'off'}`);
  const kept = readKeptWorktrees();
  if (kept.length > 0) {
    parts.push(
      `kept: unpushed work (${kept.length} worktree(s) of merged PRs: ${kept.map((k) => `${k.id.slice(0, 8)} ${k.reason.replace(/^unpushed work: /, '')}`).join(', ')})`,
    );
  }
  const hold = readHold();
  if (hold) parts.push(`dispatches held since ${hold.since}`);
  const short = free !== undefined && minFreeGB > 0 && free < minFreeGB * GB;
  return { check: 'disk', status: free === undefined || short || hold || kept.length > 0 ? 'warn' : 'ok', detail: parts.join('; ') };
}

export async function runDoctor(now = Date.now()): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const push = (check: string, status: DoctorRow['status'], detail: string) => rows.push({ check, status, detail });

  const major = Number(process.versions.node.split('.')[0]);
  push('node', major >= 20 ? 'ok' : 'fail', `v${process.versions.node}${major >= 20 ? '' : ' — lobstah needs >=20'}`);
  push('git', onPath('git') ? 'ok' : 'fail', onPath('git') ? 'on PATH' : 'not on PATH');

  const claude = onPath('claude');
  push('harness claude', claude ? 'ok' : 'warn', claude ? 'on PATH' : 'claude not on PATH — claude dispatches will fail');
  const codexPath = onPath('codex');
  // The SDK is ESM-only with an import-condition-only exports map, so this
  // must go through packagePresent — a bare require.resolve throws even when
  // the package is installed and importable.
  const codexSdk = packagePresent('@openai/codex-sdk');
  push(
    'harness codex',
    codexPath || codexSdk ? 'ok' : 'warn',
    codexPath ? 'on PATH' : codexSdk ? 'vendored SDK (attach uses it too)' : 'neither codex nor the SDK — codex dispatches will fail',
  );

  try {
    const port = glassPort();
    const info = await probeGlass(port);
    const installed = process.platform === 'win32' ? false : fs.existsSync(serviceFile('glass'));
    push(
      'glass',
      info ? 'ok' : 'warn',
      `${installed ? 'service installed' : 'service not installed'}; ${info ? `${glassUrl(port)} answering (v${info.version})` : `${glassUrl(port)} not answering (CLI v${lobstahVersion()})`}`,
    );
  } catch (err) {
    push('glass', 'warn', err instanceof Error ? err.message : String(err));
  }

  const pet = petRow({ now });
  push(pet.check, pet.status, pet.detail);

  const cfgFile = configPath();
  if (!fs.existsSync(cfgFile)) {
    push('config', 'fail', `${cfgFile} missing — run \`lobstah init\``);
    return rows;
  }
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = parse(fs.readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    push('config', 'ok', cfgFile);
  } catch (err) {
    push('config', 'fail', `${cfgFile}: ${err instanceof Error ? err.message : String(err)}`);
    return rows;
  }

  const cfg = loadConfig();
  const repoKeys = Object.keys(cfg.repos);
  if (repoKeys.length === 0) push('repos', 'warn', 'none configured — add one with `lobstah repos add <path>`');
  for (const [key, repo] of Object.entries(cfg.repos)) {
    const label = `repo ${key}`;
    if (!fs.existsSync(repo.path)) {
      push(label, 'fail', `path ${repo.path} does not exist`);
      continue;
    }
    if (!git(repo.path, 'rev-parse', '--is-inside-work-tree').ok) {
      push(label, 'fail', `${repo.path} is not a git repository`);
      continue;
    }
    const trunk = git(repo.path, 'rev-parse', '--verify', '--quiet', `origin/${repo.trunk}`);
    push(
      label,
      trunk.ok ? 'ok' : 'warn',
      trunk.ok ? `${repo.path} (trunk origin/${repo.trunk})` : `origin/${repo.trunk} not found — check trunk or \`git fetch\``,
    );
  }

  for (const row of githubRows(githubRepos(cfg.repos))) push(row.check, row.status, row.detail);

  if (parsed.pickup) {
    try {
      const pk = loadPickupConfig();
      const sources = [...pk.github.map((g) => `gh:${g.repo}→${g.key}`), ...(pk.linear ? ['linear'] : [])];
      push('pickup', sources.length > 0 ? 'ok' : 'warn', sources.join(', ') || 'section present but no sources');
    } catch (err) {
      push('pickup', 'fail', err instanceof Error ? err.message : String(err));
    }
  }

  const hb = executorPath();
  const workSlots = slotUsage('work');
  const choreSlots = slotUsage('chore');
  const trapNames = listTraps().map(trapLabel);
  const parked = parkedSummary();
  const slots = `headless: ${workSlots.headless} of ${cfg.limits.maxConcurrent} work, ${choreSlots.headless} of ${cfg.limits.choreConcurrent} chore; traps: ${workSlots.traps + choreSlots.traps}${trapNames.length ? ` (${trapNames.join(', ')})` : ''}${parked ? `; ${parked}` : ''}`;
  if (!fs.existsSync(hb)) {
    push('daemon', 'warn', `no heartbeat — daemon not running (\`lobstah daemon install\`); ${slots}`);
  } else {
    try {
      const payload = JSON.parse(fs.readFileSync(hb, 'utf8')) as { heartbeat?: string; version?: string };
      const age = now - new Date(payload.heartbeat ?? 0).getTime();
      push(
        'daemon',
        age < HEARTBEAT_STALE_MS ? 'ok' : 'warn',
        age < HEARTBEAT_STALE_MS
          ? `heartbeat ${Math.round(age / 1000)}s ago (v${payload.version ?? '?'}); ${slots}`
          : `heartbeat stale (${Math.round(age / 1000)}s) — daemon down or wedged; ${slots}`,
      );
    } catch {
      push('daemon', 'warn', `heartbeat unreadable; ${slots}`);
    }
  }

  const repairer = liveRepairer(now);
  push(
    'PR repairer',
    cfg.watch.autoRepair ? (repairer ? 'ok' : 'warn') : 'skip',
    cfg.watch.autoRepair
      ? repairer
        ? `${repairer.process} pid ${repairer.pid}; heartbeat ${Math.round((now - Date.parse(repairer.at)) / 1000)}s ago`
        : 'no repairer is running'
      : 'auto-repair is off',
  );

  // A waiting repair is information, not a failure: nothing here needs a person.
  const waiting = cfg.watch.autoRepair ? waitingRepairs() : [];
  if (waiting.length > 0) {
    push(
      'PR repairs waiting',
      'ok',
      waiting.map((pr) => `${pr.key} ${pr.repair!.kind}: ${pr.repair!.heldBy ?? 'held'} — ${pr.repair!.reason ?? ''}`).join('; '),
    );
  }
  const chores = cfg.watch.autoRepair ? repairChores() : [];
  if (chores.length > 0) {
    push('PR repair chores', 'ok', chores.map((r) =>
      `${r.pr} ${r.lane} ${r.state} ${r.worker}${r.waitingForTrap ? ` waiting for trap until ${r.until}` : ''}`).join('; '));
  }

  const disk = diskRow(cfg);
  push(disk.check, disk.status, disk.detail);

  // Registrations from before worktree-anchored traps have no trapId and
  // can never claim work again — surface them instead of ignoring quietly.
  try {
    const soaking = path.join(lobstahHome(), 'soaking');
    const stale = fs
      .readdirSync(soaking)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => {
        try {
          return typeof (JSON.parse(fs.readFileSync(path.join(soaking, f), 'utf8')) as { trapId?: unknown }).trapId !== 'string';
        } catch {
          return true;
        }
      });
    if (stale.length > 0) {
      push(
        'soaking registry',
        'warn',
        `${stale.length} pre-0.5 registration(s) without a trap id — inert; delete them and re-soak from each worktree`,
      );
    }
  } catch {
    // no soaking dir — nothing to check
  }

  push('lobstah', 'ok', `v${lobstahVersion()} at ${process.argv[1] ?? '?'}`);
  for (const row of pluginRows(lobstahVersion())) push(row.check, row.status, row.detail);
  for (const h of [claudeHooks(), codexHooks()]) {
    const row = hookRow(h, now);
    push(row.check, row.status, row.detail);
  }
  const listeners = listenerRow(now);
  push(listeners.check, listeners.status, listeners.detail);
  return rows;
}
