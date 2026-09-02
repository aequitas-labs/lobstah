import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { configPath, executorPath, loadConfig, lobstahVersion, onPath } from '@lobstah/core';
import { loadPickupConfig } from '@lobstah/pick';

export interface DoctorRow {
  check: string;
  status: 'ok' | 'warn' | 'fail';
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
export function runDoctor(now = Date.now()): DoctorRow[] {
  const rows: DoctorRow[] = [];
  const push = (check: string, status: DoctorRow['status'], detail: string) => rows.push({ check, status, detail });

  const major = Number(process.versions.node.split('.')[0]);
  push('node', major >= 20 ? 'ok' : 'fail', `v${process.versions.node}${major >= 20 ? '' : ' — lobstah needs >=20'}`);
  push('git', onPath('git') ? 'ok' : 'fail', onPath('git') ? 'on PATH' : 'not on PATH');

  const claude = onPath('claude');
  push('harness claude', claude ? 'ok' : 'warn', claude ? 'on PATH' : 'claude not on PATH — claude dispatches will fail');
  const codexPath = onPath('codex');
  let codexSdk = false;
  try {
    createRequire(import.meta.url).resolve('@openai/codex-sdk');
    codexSdk = true;
  } catch {
    // absent
  }
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

  push('lobstah', 'ok', `v${lobstahVersion()} at ${process.argv[1] ?? '?'}`);
  return rows;
}
