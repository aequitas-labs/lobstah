import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, heartbeatTrap, listNotices, readTrap, signOnTrap } from '@lobstah/core';
import { tick } from '../src/daemon.js';

let home: string;
const TTL = 60_000;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-resume-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[soak]\nttlSecs = 60\n');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

it.each([false, true])('gives every trap a full resume TTL (heartbeat renewed: %s)', (renewed) => {
  const worktree = path.join(home, 'checkout');
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, harness: 'codex', sessionId: 's', ttlMs: TTL });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  const id = signed.ok.trapId;
  heartbeatTrap(id, { parked: true });
  const start = Date.now();
  tick();
  const resume = start + TTL * 3;
  vi.setSystemTime(resume);
  tick();
  expect(readTrap(id)).toBeDefined();
  expect(listNotices().some((n) => n.kind === 'trap-ghosted')).toBe(false);
  vi.setSystemTime(resume + TTL / 2);
  tick();
  if (renewed) heartbeatTrap(id, { parked: true });
  vi.setSystemTime(resume + TTL);
  tick();
  expect(readTrap(id)).toBeDefined();
  vi.setSystemTime(resume + TTL + 1);
  tick();
  expect(readTrap(id) !== undefined).toBe(renewed);
  expect(listNotices().some((n) => n.kind === 'trap-ghosted')).toBe(!renewed);
});
