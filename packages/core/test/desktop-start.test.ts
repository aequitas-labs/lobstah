import { beforeEach, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLayout, loadConfig, requestDesktopStart, standingDecisions, signOnTrap, heartbeatTrap, acquireDesktopLease, releaseDesktopLease, stowTrap, enqueue, claimBait, appendStatus, readTrap, type TrapRegistration } from '../src/index.js';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-desktop-')); process.env.LOBSTAH_HOME = home; ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[traps.desk]\nharness="claude"\nsurface="claude-desktop"\ngrounds="fleet"\n[traps.second]\nharness="claude"\nsurface="claude-desktop"\ngrounds="fleet"\n');
});
afterEach(() => { delete process.env.LOBSTAH_HOME; fs.rmSync(home, { recursive: true, force: true }); });
function signOn(name: string, session: string): TrapRegistration {
  const start = requestDesktopStart(loadConfig(), name, 'helm');
  const result = signOnTrap({ trapId: start.slot.trapId, configured: start.slot, worktree: start.slot.cwd, cwd: start.slot.cwd, harness: 'claude', sessionId: session, ttlMs: 60_000, window: { entrypoint: 'claude-desktop' } });
  if ('held' in result) throw new Error('held');
  return result.ok;
}

it('files one concrete Code start card and keeps it until the actual first park', () => {
  const first = requestDesktopStart(loadConfig(), 'desk', 'helm');
  const repeated = requestDesktopStart(loadConfig(), 'desk', 'helm');
  expect(repeated.card.key).toBe(first.card.key);
  const url = new URL(first.start.url);
  expect(url.protocol).toBe('claude:'); expect(url.host).toBe('code'); expect(url.pathname).toBe('/new');
  expect(url.searchParams.get('folder')).toBe(first.slot.cwd);
  expect(url.searchParams.get('q')).toContain('soak --trap desk');
  expect(url.searchParams.get('q')).not.toContain('--ticket');
  const registration = signOn('desk', 'session');
  expect(standingDecisions()).toHaveLength(1);
  heartbeatTrap(registration.trapId, { parked: true });
  expect(standingDecisions()).toHaveLength(0);
});

it('serializes desktop catches across profiles, releasing on pause and completion', () => {
  const first = signOn('desk', 'one'), second = signOn('second', 'two');
  const target = (profile: string) => ({ kind: 'configured-trap' as const, profile, grounds: 'fleet', surface: 'claude-desktop' as const });
  enqueue({ id: 'first', for: 'trap:desk', target: target('desk'), brief: 'Inspect' });
  enqueue({ id: 'second', for: 'trap:second', target: target('second'), brief: 'Inspect' });
  expect(claimBait(first)?.id).toBe('first');
  expect(claimBait(second)).toBeNull();
  appendStatus('first', 'work', 'paused', 'Waiting', undefined, { waitingOn: 'external' });
  expect(claimBait(second)?.id).toBe('second');
  expect(() => appendStatus('first', 'work', 'working', 'Resume')).toThrow(/host UI/);
  appendStatus('second', 'work', 'done', 'Complete');
  expect(() => appendStatus('first', 'work', 'working', 'Resume')).not.toThrow();
  stowTrap(first.trapId);
  expect(acquireDesktopLease(readTrap(second.trapId)!)).toBe(true);
  releaseDesktopLease(second.trapId);
});
