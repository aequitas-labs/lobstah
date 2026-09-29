import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendStatus,
  enqueue,
  ensureLayout,
  executorPath,
  loadConfig,
  readRelease,
  relieveHelm,
  resolveGrounds,
  sendMessage,
  takeHelm,
} from '@lobstah/core';
import type { TendAttention } from '@lobstah/core';
import { pendingNotifications } from '@lobstah/supervisor';
import { buildGlassSnapshot } from '../src/glass.js';

// End to end against the built CLI (`pnpm build` runs before `pnpm test`).
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const HELM = '7e740e13-0000-4000-8000-000000000002';
const ID = '51151151-1111-4111-8111-111111111111';
const KEY = `work:${ID}`;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-question-hold-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
  // One repo, so the implicit "fleet" grounds covers it. The Stop hook arms
  // (never parks) and does not wait for a watcher.
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `[repos.r]\npath = "${home.replace(/\\/g, '/')}"\ntrunk = "main"\n\n[helm]\npark = "arm"\narmGraceSecs = 0\n`,
  );
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function lobstah(args: string[], input = '') {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 15_000, input });
}
const pet = () => (JSON.parse(lobstah(['attention', '--json']).stdout) as { attention: TendAttention[] }).attention.filter((a) => a.kind === 'question');
const tend = () => (JSON.parse(lobstah(['man', 'tend', '--json']).stdout) as { attention: TendAttention[] }).attention.filter((a) => a.kind === 'question');
const haul = () => lobstah(['man', 'haul'], JSON.stringify({ session_id: HELM, hook_event_name: 'Stop' }));
const signOn = () => {
  const cfg = loadConfig();
  takeHelm({ sessionId: HELM, grounds: resolveGrounds(cfg), ttlMs: cfg.helm.ttlSecs * 1000 });
};
const ask = (note = 'which tray?') => {
  appendStatus(ID, 'work', 'needs-decision', note);
};

describe('a question on the helm’s turn', () => {
  beforeEach(() => {
    enqueue({ id: ID, repo: 'r', brief: 'b' });
  });

  it('is held from the pet while a helm is signed on, and listed held in man tend', () => {
    signOn();
    ask();
    expect(pet()).toEqual([]);
    expect(tend()).toEqual([expect.objectContaining({ key: KEY, held: true, repo: 'r' })]);
    expect(lobstah(['attention']).stdout).toMatch(/work:51151151[^\n]*,question,,yes,which tray\?/);
    expect(lobstah(['man', 'tend']).stdout).toMatch(/51151151[^\n]*needs-decision,\d+,yes,which tray\?/);
    // The glass reads the pet's list; notifyCommand waits too.
    expect(buildGlassSnapshot().attention.filter((a) => a.kind === 'question')).toEqual([]);
    expect(pendingNotifications(ID, 'work')).toEqual([]);
  });

  it('walks after the helm ends a turn without answering: not held, release recorded', () => {
    signOn();
    ask();
    haul();
    expect(pet()).toEqual([expect.objectContaining({ key: KEY })]);
    expect(pet()[0]!.held).toBeUndefined();
    expect(readRelease(KEY)).toMatchObject({ key: KEY, by: HELM, stateHash: tend()[0]!.stateHash });
    expect(buildGlassSnapshot().attention.map((a) => a.key)).toContain(KEY);
    expect(pendingNotifications(ID, 'work').map((e) => e.entry.verb)).toEqual(['needs-decision']);
  });

  it('an answered question never walks: no release, no notification', async () => {
    signOn();
    ask();
    await new Promise((r) => setTimeout(r, 10)); // an answer is newer than the question
    sendMessage(ID, 'work', 'the blue one', 'helm');
    haul();
    expect(pet()).toEqual([]);
    expect(tend()).toEqual([]);
    expect(readRelease(KEY)).toBeUndefined();
    expect(pendingNotifications(ID, 'work')).toEqual([]);
  });

  it('with no helm signed on, the question walks at once', () => {
    ask();
    expect(pet()).toEqual([expect.objectContaining({ key: KEY })]);
    expect(tend()[0]!.held).toBeUndefined();
    expect(pendingNotifications(ID, 'work').map((e) => e.entry.verb)).toEqual(['needs-decision']);
  });

  it('walks at the next tend once the helm is relieved', () => {
    signOn();
    ask();
    expect(pet()).toEqual([]);
    relieveHelm(HELM);
    expect(pet()).toEqual([expect.objectContaining({ key: KEY })]);
  });

  it('walks when the helm registration is stale past [helm].ttlSecs', () => {
    const cfg = loadConfig();
    takeHelm({ sessionId: HELM, grounds: resolveGrounds(cfg), ttlMs: cfg.helm.ttlSecs * 1000, now: Date.now() - (cfg.helm.ttlSecs + 60) * 1000 });
    ask();
    expect(pet()).toEqual([expect.objectContaining({ key: KEY })]);
  });

  it('a question filed again (new stateHash) is held again', () => {
    signOn();
    ask('which tray?');
    haul();
    expect(pet()).toHaveLength(1);
    const first = readRelease(KEY)!.stateHash;
    // The worker moves on, then asks again: a new entry, a new stateHash.
    appendStatus(ID, 'work', 'working', 'trying the blue one');
    ask('which lid?');
    expect(pet()).toEqual([]);
    const [item] = tend();
    expect(item).toMatchObject({ held: true, note: 'which lid?' });
    expect(item!.stateHash).not.toBe(first);
    haul();
    expect(pet()).toEqual([expect.objectContaining({ note: 'which lid?' })]);
  });
});
