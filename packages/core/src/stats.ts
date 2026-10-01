/** Local historical counts, keyed by trap name across the project fleet. */
export interface TrapStats {
  name: string;
  keepers: number;
  firstSeen: string | null;
  lastKeeperAt: string | null;
}

export interface Stats {
  traps: number;
  keepers: number;
  perTrap: TrapStats[];
}

/** One dispatch's delivery receipt and current final state, not one row per report. */
export interface StatsDispatch {
  name: string;
  firstSeen?: string;
  verb?: string;
  at?: string;
}

const timestamp = (value?: string): string | null => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Pure derivation: no disk, registration, transport, or telemetry dependencies. */
export function deriveStats(dispatches: readonly StatsDispatch[], names: readonly string[] = []): Stats {
  const traps = new Map<string, TrapStats>();
  const trap = (name: string) => {
    let row = traps.get(name);
    if (!row) traps.set(name, row = { name, keepers: 0, firstSeen: null, lastKeeperAt: null });
    return row;
  };
  for (const name of names) trap(name);
  for (const dispatch of dispatches) {
    const row = trap(dispatch.name);
    const first = timestamp(dispatch.firstSeen);
    if (first && (!row.firstSeen || first < row.firstSeen)) row.firstSeen = first;
    if (dispatch.verb !== 'done') continue;
    row.keepers++;
    const at = timestamp(dispatch.at);
    if (at && (!row.lastKeeperAt || at > row.lastKeeperAt)) row.lastKeeperAt = at;
  }
  const perTrap = [...traps.values()].sort((a, b) => b.keepers - a.keepers || a.name.localeCompare(b.name));
  return { traps: perTrap.length, keepers: perTrap.reduce((n, row) => n + row.keepers, 0), perTrap };
}
