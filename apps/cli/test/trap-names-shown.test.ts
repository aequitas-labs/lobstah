import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  claimBait,
  enqueue,
  ensureLayout,
  nameTrapsIn,
  signOnTrap,
  stowTrap,
  trapAddressText,
  trapNamer,
} from '@lobstah/core';
import type { TrapRegistration } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';

/**
 * A dispatch names its trap by name wherever it shows one: the live
 * registration's name, else the name registry's for a signed-off trap,
 * else `wt:<id>`.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-trap-names-shown-'));
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
  delete env.CODEX_THREAD_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 20_000 });
}

const LIVE = 'aaaaaaaa-0000-4000-8000-000000000001';
const GONE = 'bbbbbbbb-0000-4000-8000-000000000002';
const UNKNOWN = 'cccccccc-0000-4000-8000-000000000003';
const WAITS = 'dddddddd-0000-4000-8000-000000000004';

function signOn(name: string, session: string): TrapRegistration {
  const worktree = path.join(home, 'wt-' + name);
  fs.mkdirSync(worktree, { recursive: true });
  const signed = signOnTrap({ sessionId: session, harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000, name });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  return signed.ok;
}

/** crisp-heron is live and claimed LIVE; kind-crab claimed GONE, then signed off; UNKNOWN waits for wt:deadbeef. */
function fleet(): { live: TrapRegistration; gone: TrapRegistration } {
  const live = signOn('crisp-heron', 'session-live');
  enqueue({ id: LIVE, repo: 'web', brief: 'live work', for: `wt:${live.trapId}` });
  expect(claimBait(live)?.id).toBe(LIVE);
  const gone = signOn('kind-crab', 'session-gone');
  enqueue({ id: GONE, repo: 'web', brief: 'gone work', for: `wt:${gone.trapId}` });
  expect(claimBait(gone)?.id).toBe(GONE);
  stowTrap(gone.trapId);
  enqueue({ id: UNKNOWN, repo: 'web', brief: 'nobody', for: 'wt:deadbeef' });
  enqueue({ id: WAITS, repo: 'web', brief: 'for the signed-off trap', for: `wt:${gone.trapId}` });
  return { live, gone };
}

describe('trap names: the resolver', () => {
  it('resolves a live trap, a signed-off trap from the registry, and falls back to wt:<id>', () => {
    const { live, gone } = fleet();
    const names = trapNamer();
    expect(names(live.trapId)).toBe('crisp-heron');
    expect(names(gone.trapId)).toBe('kind-crab');
    expect(names('deadbeef')).toBeUndefined();
    expect(trapAddressText(`wt:${live.trapId}`)).toBe('crisp-heron');
    expect(trapAddressText(`wt:${gone.trapId}`, 'label')).toBe(`kind-crab (wt:${gone.trapId})`);
    expect(trapAddressText('wt:deadbeef', 'label')).toBe('wt:deadbeef');
    expect(trapAddressText('headless')).toBe('headless');
    expect(nameTrapsIn(`claimed by wt:${live.trapId}`)).toBe('claimed by crisp-heron');
    // A label already in the text stays whole.
    expect(nameTrapsIn(`trap crisp-heron (wt:${live.trapId}) signed on`)).toBe(`trap crisp-heron (wt:${live.trapId}) signed on`);
  });
});

describe('trap names: the glass snapshot', () => {
  it('maps each shown trap id to its name, live or signed off, and leaves an unknown id out', () => {
    const { live, gone } = fleet();
    const snap = buildGlassSnapshot();
    expect(snap.trapNames).toEqual({ [live.trapId]: 'crisp-heron', [gone.trapId]: 'kind-crab' });
    expect(snap.traps.find((t) => t.trapId === gone.trapId)).toMatchObject({ live: false, name: 'kind-crab' });
    expect(snap.dispatches.find((x) => x.id === LIVE)?.note).toBe(`claimed by wt:${live.trapId}`);
  });
});

describe('trap names: the CLI', () => {
  it('status prints name (wt:<id>) for a live trap, a signed-off trap, and wt:<id> for an unknown one', () => {
    const { live, gone } = fleet();
    const liveStatus = lobstah('status', LIVE);
    expect(liveStatus.status, liveStatus.stderr).toBe(0);
    expect(liveStatus.stdout).toContain(`trap: crisp-heron (wt:${live.trapId})`);
    expect(liveStatus.stdout).toContain(`lastNote: claimed by crisp-heron (wt:${live.trapId})`);
    expect(lobstah('status', GONE).stdout).toContain(`trap: kind-crab (wt:${gone.trapId})`);
    expect(lobstah('status', UNKNOWN).stdout).toContain('trap: wt:deadbeef');
  });

  it('catch prints name (wt:<id>)', () => {
    const { live, gone } = fleet();
    const caught = lobstah('catch', LIVE);
    expect(caught.status, caught.stderr).toBe(0);
    expect(caught.stdout).toContain(`trap: crisp-heron (wt:${live.trapId})`);
    expect(caught.stdout).toContain(`note: claimed by crisp-heron (wt:${live.trapId})`);
    expect(lobstah('catch', GONE).stdout).toContain(`trap: kind-crab (wt:${gone.trapId})`);
    expect(lobstah('catch', UNKNOWN).stdout).toContain('trap: wt:deadbeef');
  });

  it("man tend's tables print the name alone, and wt:<id> for an unknown trap", () => {
    const { gone } = fleet();
    const tend = lobstah('man', 'tend');
    expect(tend.status, tend.stderr).toBe(0);
    const awaiting = tend.stdout.slice(tend.stdout.indexOf('awaiting-trap')).split('\n\n')[0]!;
    expect(awaiting).toContain(`${WAITS.slice(0, 8)},kind-crab,`);
    expect(awaiting).toContain(`${UNKNOWN.slice(0, 8)},wt:deadbeef,`);
    expect(awaiting).not.toContain(`wt:${gone.trapId}`);
  });
});
