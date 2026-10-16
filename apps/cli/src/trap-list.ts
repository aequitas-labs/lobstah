import { listRoster, listTraps, listReservations, readRoster, repoTrapCount, trapAvailability, trapLabel, workerLabel, toonTable, type Config, type TrapRegistration, type WorkerConfig } from '@lobstah/core';
import { startMode } from './throw.js';

/**
 * A live trap's worker label with the mode it runs in. Claude Code reports
 * its mode to hooks, and a person can change it mid-session, so what was
 * seen wins. Codex reports `default` whatever its approvals, so the mode
 * its throw started it in wins there.
 */
function liveWorker(r: TrapRegistration): string {
  const started = readRoster(r.trapId)?.startMode as WorkerConfig['permissionMode'] | undefined;
  const seen = r.config?.permissionMode ?? undefined;
  const permissionMode = (r.harness === 'codex' ? (started ?? seen) : (seen ?? started)) ?? null;
  return workerLabel({ ...r, config: { ...r.config, permissionMode } });
}

/** One shared CLI/Stop summary; stowed/ghosted roster entries never masquerade as live traps. */
export function trapRows(now = Date.now(), repos?: readonly string[]) {
  const live = listTraps();
  const reservations = listReservations();
  const rows = live.map((r) => {
    const availability = trapAvailability(r, now);
    const hbAgeSecs = Math.max(0, Math.round((now - Date.parse(r.heartbeatAt)) / 1000));
    return {
      trap: `wt:${r.trapId}`, name: r.name, label: trapLabel(r), session: r.sessionId.slice(0, 8),
      worker: liveWorker(r), repo: r.repo ?? '(addressed only)', worktree: r.worktree,
      claimed: availability.dispatch, availability: availability.text,
      listening: r.firstParkedAt === undefined ? 'never' : hbAgeSecs <= 10 ? 'now' : `${hbAgeSecs}s ago`,
      state: undefined as 'starting' | 'start-failed' | 'stowed' | 'ghosted' | undefined,
    };
  });
  for (const r of reservations) {
    const failed = r.failedAt !== undefined || now > Date.parse(r.deadline);
    rows.push({ trap: `wt:${r.trapId}`, name: r.name, label: trapLabel(r), session: '', worker: r.harness ?? '',
      repo: r.repo, worktree: r.worktree ?? '', claimed: undefined, availability: failed ? 'start failed' : 'starting',
      listening: failed ? 'start failed' : `starting (due in ${Math.max(0, Math.round((Date.parse(r.deadline) - now) / 1000))}s)`,
      state: failed ? 'start-failed' : 'starting' });
  }
  const present = new Set(rows.map((r) => r.trap));
  for (const r of listRoster()) {
    if (present.has(`wt:${r.trapId}`)) continue;
    const state = r.state === 'ghosted' ? 'ghosted' : 'stowed';
    rows.push({ trap: `wt:${r.trapId}`, name: r.name, label: trapLabel(r), session: r.sessionId.slice(0, 8),
      // A stowed trap shows the mode its next throw starts it in.
      worker: workerLabel({ harness: r.profile?.harness ?? r.harness, model: r.profile?.model ?? r.model, config: { ...(r.profile?.config ?? r.config), permissionMode: startMode(r.profile?.config) as WorkerConfig['permissionMode'] } }),
      repo: r.repo ?? '(addressed only)', worktree: r.worktree, claimed: undefined, availability: state, listening: state, state });
  }
  return rows.filter((r) => !repos || repos.includes(r.repo)).sort((a, b) => a.label.localeCompare(b.label));
}

export function repoTrapRows(cfg: Config, repos: readonly string[] = Object.keys(cfg.repos)) {
  return repos.map((repo) => repoTrapCount(cfg, repo)).map((r) => ({ repo: r.repo, traps: r.text }));
}

export function trapSummary(cfg: Config, repos?: readonly string[], now = Date.now()): string {
  const rows = trapRows(now, repos);
  return [
    toonTable('repo-traps', repoTrapRows(cfg, repos), ['repo', 'traps']),
    ...(rows.length ? [toonTable('traps', rows, ['name', 'trap', 'worker', 'repo', 'availability', 'listening'])] : []),
  ].join('\n');
}
