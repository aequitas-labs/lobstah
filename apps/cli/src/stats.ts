import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveStats, laneDirs, lobstahHome, readDirIfPresent, readEvidence, readStatusLog, toonKV, toonTable } from '@lobstah/core';
import type { Lane, Stats, StatsDispatch } from '@lobstah/core';

let cached: { key: string; stats: Stats } | undefined;

/** Receipts and logs outlive registrations and archived dispatch directories. */
export function readStats(): Stats {
  const files: string[] = [];
  const ids: Array<{ id: string; lane: Lane }> = [];
  for (const lane of ['work', 'chore'] as const) {
    const state = laneDirs(lane).state;
    const seen = new Set<string>();
    for (const file of readDirIfPresent(state).sort()) {
      const match = /^(.*)\.(status|evidence)$/.exec(file);
      if (!match) continue;
      files.push(path.join(state, file));
      seen.add(match[1]!);
    }
    for (const id of seen) ids.push({ id, lane });
  }
  const namesDir = path.join(lobstahHome(), 'trap-names');
  const nameFiles = readDirIfPresent(namesDir).filter((f) => f.endsWith('.json')).sort();
  files.push(...nameFiles.map((f) => path.join(namesDir, f)));
  // Directory membership plus file metadata invalidates on delivery, report,
  // rename, deletion, or LOBSTAH_HOME change. Quiet polls parse no history.
  const key = JSON.stringify([lobstahHome(), files.map((file) => {
    try {
      const s = fs.statSync(file);
      return [file, s.mtimeMs, s.ctimeMs, s.size];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return [file];
    }
  })]);
  if (cached?.key === key) return cached.stats;
  const names = new Map<string, string>();
  for (const file of nameFiles) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(namesDir, file), 'utf8')) as { trapId: string };
      names.set(`wt:${reg.trapId}`, file.slice(0, -5));
    } catch (err) {
      if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const records: StatsDispatch[] = [];
  for (const { id, lane } of ids) {
    const evidence = readEvidence(id, lane);
    const address = evidence.deliveredTo;
    // An addressed but unclaimed job isn't a trap's catch. Headless jobs
    // have no wt: delivery receipt and do not contribute to trap totals.
    if (!address?.startsWith('wt:')) continue;
    const log = readStatusLog(id, lane);
    const last = log.at(-1);
    const firstSeen = [evidence.deliveredAt, ...log.map((r) => r.at)]
      .filter((at): at is string => !!at && Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    // Legacy receipts with no retained name remain visible under their stable
    // wt: address; names reused across worktrees deliberately combine totals.
    records.push({ name: names.get(address) ?? address, firstSeen, verb: last?.verb, at: last?.at });
  }
  const stats = deriveStats(records, [...names.values()]);
  cached = { key, stats };
  return stats;
}

export function renderStats(stats: Stats): string {
  return `${toonKV({ traps: stats.traps, keepers: stats.keepers })}\n${toonTable('perTrap', stats.perTrap.map((r) => ({ ...r })), ['name', 'keepers', 'firstSeen', 'lastKeeperAt'])}`;
}
