import { describe, expect, it } from 'vitest';
import { deriveStats } from '../src/stats.js';

describe('historical keeper stats', () => {
  it('counts done dispatches including plans/reports, not failed, cancelled or working', () => {
    const stats = deriveStats([
      { name: 'kind-crab', verb: 'done', firstSeen: '2026-09-01T00:00:00Z', at: '2026-09-02T00:00:00Z' },
      { name: 'kind-crab', verb: 'done', firstSeen: '2026-09-03T00:00:00Z', at: '2026-09-04T00:00:00Z' },
      { name: 'kind-crab', verb: 'failed' },
      { name: 'stowed-crab', verb: 'done', at: '2026-09-05T00:00:00Z' },
      { name: 'failed-crab', verb: 'failed' },
      { name: 'failed-crab', verb: 'cancelled' },
      { name: 'busy-crab', verb: 'working' },
    ], ['new-crab']);
    expect(stats).toEqual({ traps: 5, keepers: 3, perTrap: [
      { name: 'kind-crab', keepers: 2, firstSeen: '2026-09-01T00:00:00.000Z', lastKeeperAt: '2026-09-04T00:00:00.000Z' },
      { name: 'stowed-crab', keepers: 1, firstSeen: null, lastKeeperAt: '2026-09-05T00:00:00.000Z' },
      ...['busy-crab', 'failed-crab', 'new-crab'].map((name) => ({ name, keepers: 0, firstSeen: null, lastKeeperAt: null })),
    ] });
  });

  it('combines reused names, normalizes timestamps and ignores invalid dates', () => {
    const rows = [{ name: 'kind-crab', verb: 'done', firstSeen: 'bad', at: 'bad' },
      { name: 'kind-crab', verb: 'done', firstSeen: '2026-09-02T01:00:00+02:00', at: '2026-09-02T00:00:00Z' }];
    expect(deriveStats(rows, ['kind-crab', 'kind-crab']).perTrap).toEqual([
      { name: 'kind-crab', keepers: 2, firstSeen: '2026-09-01T23:00:00.000Z', lastKeeperAt: '2026-09-02T00:00:00.000Z' },
    ]);
    expect(deriveStats([])).toEqual({ traps: 0, keepers: 0, perTrap: [] });
  });
});
