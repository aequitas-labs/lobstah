import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimNext, ensureLayout, readStatusLog } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

// End to end against the built CLI: a trap that asked for a ume review keeps
// waiting on it, and `report done` refuses while the review is open.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLAN = '64e82b46-3d2';
let home: string;
let bin: string;

/** A stand-in `ume` that lists one artifact with this approval. */
function umeLists(approval: string): void {
  const file = path.join(bin, 'ume');
  fs.writeFileSync(file, `#!/bin/sh\necho '${JSON.stringify({ artifacts: [{ id: PLAN, approval }] })}'\n`);
  fs.chmodSync(file, 0o755);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-done-'));
  bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 15_000 });
}

function claimed(id: string): void {
  expect(lobstah('dispatch', '--repo', 'r', '--id', id, '--brief-text', 'work').status).toBe(0);
  expect(claimNext('work')).toBe(id);
}

describe.skipIf(process.platform === 'win32')('report done with a ume review still open', () => {
  it('refuses while the linked artifact is in review and writes nothing', () => {
    claimed(A);
    umeLists('requested');
    const refused = lobstah('report', A, 'done', `plan published https://app.ume.so/a/${PLAN}`);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain(`ume artifact ${PLAN} is still in review`);
    expect(refused.stdout + refused.stderr).toContain(`ume await --watch ${PLAN}`);
    expect(readStatusLog(A, 'work').map((e) => e.verb)).not.toContain('done');
  });

  it("refuses on the last report's link, and --review-done reports done anyway", () => {
    claimed(A);
    umeLists('requested');
    expect(lobstah('report', A, 'paused', 'waiting on Chris', '--waiting-on', 'review', '--link', `https://app.ume.so/a/${PLAN}`).status).toBe(0);
    expect(lobstah('report', A, 'done', 'finished').status).not.toBe(0);
    const done = lobstah('report', A, 'done', 'finished', '--review-done');
    expect(done.status, done.stderr).toBe(0);
    expect(readStatusLog(A, 'work').at(-1)?.verb).toBe('done');
  });

  it('reports done once the artifact is approved', () => {
    claimed(A);
    umeLists('approved');
    const done = lobstah('report', A, 'done', `built what https://app.ume.so/a/${PLAN} approved`);
    expect(done.status, done.stderr).toBe(0);
  });
});
