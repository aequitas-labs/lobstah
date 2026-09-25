import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  claimBait,
  claimNext,
  enqueue,
  ensureLayout,
  laneDirs,
  readSessionClaim,
  readStatusLog,
  signOnTrap,
} from '@lobstah/core';
import type { SessionClaim } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { buildTendReport } from '../src/tend.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-claimed-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/** A live trap claims the bait through the real claim path. */
function trapClaims(): { by: string; at: string } {
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const signed = signOnTrap({ sessionId: 'trap-s', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  enqueue({ id, repo: 'web', brief: 'trap work' });
  expect(claimBait(signed.ok)?.id).toBe(id);
  const claim = readSessionClaim(id, 'work')!;
  return { by: claim.by, at: claim.at };
}

/** A claim written before claims logged a status entry: claim.json, no log. */
function oldClaim(): { by: string; at: string } {
  enqueue({ id, repo: 'web', brief: 'trap work' });
  expect(claimNext('work')).toBe(id);
  const claim: SessionClaim = { by: 'wt:0ldc1a1m', sessionId: 'trap-s', harness: 'claude', worktree: '/tmp/wt', at: '2026-09-24T10:00:00.000Z' };
  fs.writeFileSync(path.join(laneDirs('work').active, id, 'claim.json'), JSON.stringify(claim));
  expect(readStatusLog(id, 'work')).toEqual([]);
  return { by: claim.by, at: claim.at };
}

describe('a trap-claimed dispatch shows working from the claim', () => {
  for (const [name, setup] of [
    ['claimBait', trapClaims],
    ['an old claim with no log', oldClaim],
  ] as const) {
    it(`${name}: status, ls, catch, glass, and tend all say working at the claim time`, () => {
      const claim = setup();

      const status = lobstah('status', id);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain('state: working');

      const ls = lobstah('ls');
      expect(ls.stdout).toContain(`${id},work,active,working,`);

      const caught = lobstah('catch', id);
      expect(caught.stdout).toContain('state: working');

      const d = buildGlassSnapshot().dispatches.find((x) => x.id === id);
      expect(d).toMatchObject({ bucket: 'active', verb: 'working', verbAt: claim.at, claimedBy: claim.by });

      const t = buildTendReport()
        .stories.flatMap((s) => s.dispatches)
        .find((x) => x.id === id);
      expect(t).toMatchObject({ bucket: 'active', state: 'working', at: claim.at });
    });
  }

  it('an active dispatch with no claim and no log stays unknown', () => {
    enqueue({ id, repo: 'web', brief: 'headless, not started' });
    claimNext('work');
    expect(lobstah('status', id).stdout).toContain('state: unknown');
    expect(buildGlassSnapshot().dispatches.find((x) => x.id === id)?.verb).toBe('unknown');
  });
});
