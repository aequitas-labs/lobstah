import * as fs from 'node:fs';
import * as path from 'node:path';
import { lobstahHome, readDirIfPresent, readStatsStore, statsPage, statsView, toonKV, toonTable } from '@lobstah/core';
import type { Stats, StatsPage } from '@lobstah/core';

/** Trap address → persistent name, from the name registry (stowed and swept traps included). */
function trapNames(): Map<string, string> {
  const dir = path.join(lobstahHome(), 'trap-names');
  const names = new Map<string, string>();
  for (const file of readDirIfPresent(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { trapId?: unknown };
      if (typeof reg.trapId === 'string') names.set(`wt:${reg.trapId}`, file.slice(0, -5));
    } catch (err) {
      if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return names;
}

/** Catches from the durable store (stats.json), which outlives cull. */
export function readStats(now = Date.now()): Stats {
  return statsView(readStatsStore(now), trapNames(), now);
}

/** The glass's Stats tab (`GET /data/stats`): the heatmap and headline numbers, read from the store only. */
export function readStatsPage(now = Date.now()): StatsPage {
  return statsPage(readStatsStore(now), trapNames(), now);
}

/** `lobstah stats [--per-trap] [--json]`: today's catches and the total; per trap only on request. */
export function statsOutput(stats: Stats, opts: { json?: boolean; perTrap?: boolean } = {}): string {
  const totals = { catchesToday: stats.catchesToday, totalCatches: stats.totalCatches };
  if (opts.json) return JSON.stringify(opts.perTrap ? { ...totals, perTrap: stats.perTrap } : totals);
  const kv = toonKV(totals);
  return opts.perTrap ? `${kv}\n${toonTable('perTrap', stats.perTrap.map((r) => ({ ...r })), ['name', 'catches'])}` : kv;
}
