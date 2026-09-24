import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue, ensureLayout, helmOf, takeHelm } from '@lobstah/core';

// Exercise the built CLI: the bug is the Stop hook's control-flow gate.
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const sessionId = 'queued-haul-helm';
const dispatchId = '88888888-8888-8888-8888-888888888888';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-haul-queue-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  takeHelm({ sessionId, grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function haul() {
  const started = Date.now();
  const res = spawnSync(process.execPath, [cli, 'man', 'haul', '--park', '--timeout', '2'], {
    encoding: 'utf8',
    env: { ...process.env, LOBSTAH_HOME: home },
    input: JSON.stringify({ session_id: sessionId }),
    timeout: 10_000,
  });
  return { ...res, elapsedMs: Date.now() - started };
}

describe('man haul --park with queued-only work', () => {
  for (const lane of ['work', 'chore'] as const) {
    it(`parks and heartbeats when ${lane} is queued`, () => {
      enqueue({ id: dispatchId, repo: 'web', brief: 'waiting for a claimant' }, lane);
      const beforeHeartbeat = Date.parse(helmOf(sessionId)!.heartbeatAt);

      const res = haul();

      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
      expect(res.elapsedMs).toBeGreaterThanOrEqual(1_500);
      expect(res.stdout).toBe(''); // a quiet Stop hook allows the stop
      expect(Date.parse(helmOf(sessionId)!.heartbeatAt) - beforeHeartbeat).toBeGreaterThanOrEqual(1_000);
    });
  }

  it('exits immediately when no dispatch is queued or active', () => {
    const res = haul();

    expect(res.signal).toBeNull();
    expect(res.status).toBe(0);
    expect(res.elapsedMs).toBeLessThan(1_500);
    expect(res.stdout).toBe('');
  });
});
