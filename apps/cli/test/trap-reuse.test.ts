import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimBait, enqueue, ensureLayout, heartbeatTrap, loadConfig, queuedDescriptor, readTrap, signOnTrap, stowTrap, sweepGhostTraps, takeHelm } from '@lobstah/core';
import { buildTendReport, renderTend } from '../src/tend.js';
import { charter, TRAP_REUSE_RULE } from '../src/charter.js';
import { trapForRepo } from '../src/throw.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const HELM = 'helm-session';
let home: string;
function run(args: string[], input?: object) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return spawnSync(process.execPath, [cli, ...args], { cwd: home, env: { ...env, LOBSTAH_HOME: home }, input: input ? JSON.stringify(input) : '', encoding: 'utf8', timeout: 20_000 });
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-reuse-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.mkdirSync(path.join(home, 'repo'));
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${path.join(home, 'repo')}'\ntraps = 2\n[helm]\narmGraceSecs = 0\n`);
  takeHelm({ sessionId: HELM, grounds: { name: 'fleet', repos: ['r'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

function trap(name: string, harness = 'claude', repo = 'r') {
  const dir = path.join(home, name); fs.mkdirSync(dir);
  const r = signOnTrap({ name, harness, repo, worktree: dir, cwd: dir, sessionId: name, ttlMs: 60_000 });
  if (!('ok' in r)) throw new Error('held');
  return r.ok;
}
function dispatch(id = 'job', extra: string[] = []) {
  return run(['dispatch', '--repo', 'r', '--trap-any', '--id', id, '--brief-text', 'work', '--session', HELM, ...extra]);
}

describe('reuse-first CLI and summaries', () => {
  it('selects a free live trap without launching and reserves it for sequential dispatches', async () => {
    const a = trap('amber-gull');
    const b = trap('kind-crab');
    const choose = await trapForRepo({ cfg: loadConfig(), repo: 'r', adapter: () => { throw new Error('must not launch'); } });
    expect(choose).toMatchObject({ action: 'reused', registration: { trapId: a.trapId } });
    const first = dispatch(); expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('trapAction: reused');
    expect(queuedDescriptor('job', 'work')?.for).toBe(`wt:${a.trapId}`);
    const second = dispatch('job2'); expect(second.status, second.stderr).toBe(0);
    expect(queuedDescriptor('job2', 'work')?.for).toBe(`wt:${b.trapId}`);
    const third = dispatch('job3'); expect(third.status, third.stderr).toBe(0);
    expect(third.stdout).toContain('all 2 r traps are busy');
    expect(queuedDescriptor('job3', 'work')).toMatchObject({ trapAny: true });
  });

  it('at capacity queues with harness restriction and status shows the queue reason', () => {
    const a = trap('amber-gull'); const b = trap('kind-crab');
    for (const [r, id] of [[a, 'a'], [b, 'b']] as const) {
      enqueue({ id, repo: 'r', brief: 'b', for: `wt:${r.trapId}` }); claimBait(r);
    }
    const out = dispatch('job', ['--harness', 'codex']);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('trapAction: waiting');
    expect(queuedDescriptor('job', 'work')).toMatchObject({ trapAny: true, harness: 'codex' });
    expect(run(['status', 'job']).stdout).toContain('all 2 r traps are busy');
  });

  it('guards --new on dry-run too, shows candidates and permits a reason only below capacity', () => {
    trap('amber-gull');
    const args = ['man', 'throw', '--new', '--repo', 'r', '--dry-run'];
    const refused = run(args);
    expect(refused.status).not.toBe(0); expect(refused.stdout).toContain('existing-traps');
    expect(refused.stdout + refused.stderr).toContain('--reason');
    const accepted = run([...args, '--reason', 'different harness required']);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain('reason: different harness required');
    trap('kind-crab');
    const full = run([...args, '--reason', 'more']);
    expect(full.status).not.toBe(0); expect(full.stdout + full.stderr).toContain('2/2 traps');
    expect(full.stdout + full.stderr).toContain('amber-gull'); expect(full.stdout + full.stderr).toContain('kind-crab');
  });

  it('lists done and failed catches as free, paused as busy, and stowed/ghosted separately in tend, status and Stop', () => {
    const a = trap('amber-gull'); const b = trap('kind-crab'); const c = trap('young-foam'); const d = trap('fresh-cove');
    for (const [r, id, verb] of [[a, 'done', 'done'], [b, 'failed', 'failed']] as const) {
      enqueue({ id, repo: 'r', brief: 'b', for: `wt:${r.trapId}` }); claimBait(r); appendStatus(id, 'work', verb);
    }
    stowTrap(c.trapId);
    heartbeatTrap(d.trapId, { parked: true });
    const old = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(path.join(home, 'soaking', `${d.trapId}.json`), JSON.stringify({ ...readTrap(d.trapId), signedOnAt: old, heartbeatAt: old, parkedAt: old }));
    sweepGhostTraps(60_000);
    // A/B remain live; D is ghosted, C is stowed.
    const report = buildTendReport();
    expect(report.traps.find((r) => r.name === 'young-foam')?.state).toBe('stowed');
    expect(report.traps.find((r) => r.name === 'fresh-cove')?.state).toBe('ghosted');
    expect(readTrap(a.trapId)).toBeDefined();
    expect(report.traps.find((r) => r.name === 'amber-gull')?.availability).toBe('free');
    expect(report.traps.find((r) => r.name === 'kind-crab')?.availability).toBe('free');
    expect(run(['status', 'young-foam']).stdout).toContain('state: stowed');
    expect(run(['status', 'fresh-cove']).stdout).toContain('state: ghosted');
    expect(renderTend(report)).toContain('4/2 traps');
    expect(renderTend(report)).toContain('over limit');
    const stop = run(['hook', 'stop'], { session_id: HELM, hook_event_name: 'Stop' });
    expect(stop.status, stop.stderr).toBe(0);
    expect(stop.stdout).toContain('young-foam'); expect(stop.stdout).toContain('stowed');
    expect(stop.stdout).toContain('fresh-cove'); expect(stop.stdout).toContain('ghosted');
  });

  it('prints the open verb and age for a paused external catch', () => {
    const r = trap('amber-gull');
    enqueue({ id: 'paused', repo: 'r', brief: 'b', for: `wt:${r.trapId}` }); claimBait(r);
    appendStatus('paused', 'work', 'paused', 'waiting for deploy', '2026-10-12T11:57:00Z', { waitingOn: 'external' });
    expect(buildTendReport(Date.parse('2026-10-12T12:00:00Z')).traps[0]?.availability).toBe('busy on paused (paused, 3m)');
    expect(run(['status', 'amber-gull']).stdout).toContain('busy on paused (paused,');
  });

  it('validates incompatible flags and requires helm authorization before choosing', () => {
    expect(dispatch('job', ['--for', 'amber-gull']).stdout).toContain('--trap-any cannot be combined');
    expect(dispatch('job', ['--pool', 'some']).stdout).toContain('--trap-any cannot be combined');
    const out = run(['dispatch', '--repo', 'r', '--trap-any', '--brief-text', 'work', '--session', 'not-helm']);
    expect(out.status).not.toBe(0); expect(queuedDescriptor('job', 'work')).toBeUndefined();
  });

  it('the helm charter and both man skills carry the same reuse rule', () => {
    expect(charter({ name: 'fleet', repos: ['r'] })).toContain(TRAP_REUSE_RULE);
    for (const plugin of ['codex', 'claude-code']) {
      const skill = fileURLToPath(new URL(`../../../plugins/${plugin}/skills/man/SKILL.md`, import.meta.url));
      expect(fs.readFileSync(skill, 'utf8')).toContain(TRAP_REUSE_RULE);
    }
  });
});
