import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claimNext, enqueue, ensureLayout, laneDirs, readStatusLog } from '@lobstah/core';
import { main } from '../src/run.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// A repair re-checks its PR before it starts: a PR that merged or closed
// while the repair waited has nothing to repair, and its branch may be gone.
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-repair-merged-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(path.join(home, 'repo'))}\ntrunk = "main"\n`);
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const PR = 'https://github.com/acme/web/pull/1854';

function claimRepair(id: string): string {
  enqueue({ id, repo: 'r', brief: 'repair the failing checks', systemRepair: {}, pr: { url: PR, headRefName: 'feature' } }, 'chore');
  expect(claimNext('chore')).toBe(id);
  return path.join(laneDirs('chore').active, id);
}

describe('a repair whose PR already ended', () => {
  for (const state of ['MERGED', 'CLOSED'] as const) {
    it(`finishes without work when the PR is ${state.toLowerCase()}`, async () => {
      const id = `92c7de01-0000-4000-8000-00000000000${state === 'MERGED' ? 1 : 2}`;
      const dir = claimRepair(id);
      const allocated: string[] = [];
      await main(dir, 'chore', {
        prState: () => state,
        allocate: async (_repo, rid) => {
          allocated.push(rid);
          throw new Error('allocate must not run');
        },
      });
      expect(allocated).toEqual([]);
      const last = readStatusLog(id, 'chore').at(-1);
      expect(last).toMatchObject({ verb: 'failed', note: `cancelled: ${PR} is ${state.toLowerCase()}; nothing to repair` });
      expect(fs.existsSync(path.join(laneDirs('chore').done, id))).toBe(true);
    });
  }

  it('an open PR goes on to allocate its worktree as before', async () => {
    const id = '92c7de01-0000-4000-8000-000000000003';
    const dir = claimRepair(id);
    await expect(
      main(dir, 'chore', {
        prState: () => 'OPEN',
        allocate: async () => {
          throw new Error('reached allocate');
        },
      }),
    ).rejects.toThrow('reached allocate');
  });
});
