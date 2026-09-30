import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimBait, enqueue, ensureLayout, readActivity, readBeat, readTrap, signOnTrap, writeActivity } from '@lobstah/core';
import type { TrapRegistration } from '@lobstah/core';
import { buildGlassSnapshot } from '../src/glass.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-activity-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(args: string[], opts: { input?: string; cwd?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000, input: opts.input ?? '', cwd: opts.cwd });
}

const id = 'aaaaaaaa-1111-2222-3333-444444444444';

function caughtTrap(): TrapRegistration {
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const signed = signOnTrap({ sessionId: 'trap-s', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  enqueue({ id, repo: 'web', brief: 'trap work' });
  expect(claimBait(signed.ok)?.id).toBe(id);
  return readTrap(signed.ok.trapId)!;
}

const hook = (reg: TrapRegistration, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 'trap-s',
    cwd: reg.worktree,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123 pnpm test --filter core' },
    tool_response: { stdout: 'secret output' },
    ...extra,
  });

describe('lobstah soak beat', () => {
  it('refreshes the trap and writes its catch activity; silent, exit 0', () => {
    const reg = caughtTrap();
    const res = lobstah(['soak', 'beat'], { input: hook(reg) });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(readBeat(reg.trapId)).toBeDefined();
    expect(readActivity(id, 'work')).toMatchObject({ kind: 'tool', summary: 'Bash pnpm' });
  });

  it('is inert when the session is not soaking', () => {
    const plain = path.join(home, 'plain');
    fs.mkdirSync(plain);
    const res = lobstah(['soak', 'beat'], { input: JSON.stringify({ session_id: 'x', cwd: plain, tool_name: 'Read' }) });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(fs.readdirSync(path.join(home, 'soaking')).filter((f) => f.endsWith('.beat'))).toEqual([]);
  });

  it('does nothing with [soak].beat = false', () => {
    const reg = caughtTrap();
    fs.writeFileSync(path.join(home, 'config.toml'), '[soak]\nbeat = false\n');
    const res = lobstah(['soak', 'beat'], { input: hook(reg) });
    expect(res.status).toBe(0);
    expect(readBeat(reg.trapId)).toBeUndefined();
    expect(readActivity(id, 'work')).toBeUndefined();
  });

  it('always exits 0: garbage stdin, no stdin, a broken config', () => {
    const reg = caughtTrap();
    expect(lobstah(['soak', 'beat'], { input: 'not json{' }).status).toBe(0);
    expect(lobstah(['soak', 'beat']).status).toBe(0);
    fs.writeFileSync(path.join(home, 'config.toml'), '[soak\nbeat = ');
    const res = lobstah(['soak', 'beat'], { input: hook(reg) });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(fs.readFileSync(path.join(home, 'logs', 'beat.log'), 'utf8')).toMatch(/\S/);
  });
});

describe('activity in status, ls, tend, and the glass', () => {
  it('shows fresh activity, and marks it stale past wedgeThresholdSecs', () => {
    caughtTrap();
    writeActivity(id, 'work', { at: new Date(Date.now() - 12_000).toISOString(), kind: 'tool', summary: 'Edit src/a.ts' });

    const status = lobstah(['status', id]);
    expect(status.stdout).toMatch(/^activity: Edit src\/a\.ts \(1\ds ago\)$/m);
    expect(lobstah(['ls']).stdout).toMatch(new RegExp(`${id},work,active,working,[^,]+,,Edit src/a\\.ts \\(1\\ds ago\\)`));

    const tend = buildTendReport();
    const d = tend.stories.flatMap((s) => s.dispatches).find((x) => x.id === id)!;
    expect(d.activity).toMatchObject({ summary: 'Edit src/a.ts', stale: false });
    expect(renderTend(tend)).toMatch(/Edit src\/a\.ts \(1\ds ago\)/);
    const g = buildGlassSnapshot().dispatches.find((x) => x.id === id)!;
    expect(g.activity).toMatchObject({ kind: 'tool', summary: 'Edit src/a.ts', stale: false });

    writeActivity(id, 'work', { at: new Date(Date.now() - 15 * 60_000).toISOString(), kind: 'tool', summary: 'Edit src/a.ts' });
    expect(lobstah(['status', id]).stdout).toContain('activity: stale: Edit src/a.ts (15m ago)');
    expect(buildGlassSnapshot().dispatches.find((x) => x.id === id)!.activity?.stale).toBe(true);
    expect(renderTend(buildTendReport())).toContain('stale: Edit src/a.ts (15m ago)');
    // No new attention kind: a long silence is displayed, not escalated.
    expect(buildTendReport().attention).toEqual([]);
  });
});
