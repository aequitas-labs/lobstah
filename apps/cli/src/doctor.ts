import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { configPath, executorPath, loadConfig, lobstahHome, lobstahVersion, onPath, packagePresent } from '@lobstah/core';
import { loadPickupConfig } from '@lobstah/pick';
import { installedClaudePlugin, installedCodexPlugin, pluginDrift, UPDATE_COMMAND } from './plugin-version.js';

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
 * the CLI's, compared on major.minor (plugin versions track the CLI).
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
      rows.push({ check, status: 'skip', detail: `v${p.version} installed; this CLI is a dev build (v${cliVersion}) — nothing to compare` });
      continue;
    }
    const drift = pluginDrift(p.version, cliVersion);
    rows.push(
      drift === 'match'
        ? { check, status: 'ok', detail: `v${p.version} matches CLI v${cliVersion} (${p.root})` }
        : {
            check,
            status: 'warn',
            detail: `plugin v${p.version} is ${drift} CLI v${cliVersion} — ${drift === 'behind' ? UPDATE_COMMAND[harness] : 'update the CLI: npm i -g lobstah'} (${p.root})`,
          },
    );
  }
  return rows;
}

export function runDoctor(now = Date.now()): DoctorRow[] {
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

  if (parsed.pickup) {
    try {
      const pk = loadPickupConfig();
      const sources = [
        ...pk.github.map((g) => `gh:${g.repo}→${g.key}`),
        ...(pk.linear ? ['linear'] : []),
      ];
      push('pickup', sources.length > 0 ? 'ok' : 'warn', sources.join(', ') || 'section present but no sources');
    } catch (err) {
      push('pickup', 'fail', err instanceof Error ? err.message : String(err));
    }
  }

  const hb = executorPath();
  if (!fs.existsSync(hb)) {
    push('daemon', 'warn', 'no heartbeat — daemon not running (`lobstah daemon install`)');
  } else {
    try {
      const payload = JSON.parse(fs.readFileSync(hb, 'utf8')) as { heartbeat?: string; version?: string };
      const age = now - new Date(payload.heartbeat ?? 0).getTime();
      push(
        'daemon',
        age < HEARTBEAT_STALE_MS ? 'ok' : 'warn',
        age < HEARTBEAT_STALE_MS
          ? `heartbeat ${Math.round(age / 1000)}s ago (v${payload.version ?? '?'})`
          : `heartbeat stale (${Math.round(age / 1000)}s) — daemon down or wedged`,
      );
    } catch {
      push('daemon', 'warn', 'heartbeat unreadable');
    }
  }

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
  return rows;
}
