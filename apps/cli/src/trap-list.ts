import { listRoster, listTraps, listReservations, repoTrapCount, trapAvailability, trapLabel, workerLabel, toonTable, type Config } from '@lobstah/core';

/** One shared CLI/Stop summary; stowed/ghosted roster entries never masquerade as live traps. */
export function trapRows(now = Date.now(), repos?: readonly string[]) {
  const live = listTraps();
  const reservations = listReservations();
  const rows = live.map((r) => {
    const availability = trapAvailability(r, now);
    const hbAgeSecs = Math.max(0, Math.round((now - Date.parse(r.heartbeatAt)) / 1000));
    return {
      trap: `wt:${r.trapId}`, name: r.name, label: trapLabel(r), session: r.sessionId.slice(0, 8),
      worker: workerLabel(r), repo: r.repo ?? '(addressed only)', worktree: r.worktree,
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
      worker: workerLabel({ harness: r.profile?.harness ?? r.harness, model: r.profile?.model ?? r.model, config: r.profile?.config ?? r.config }),
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
