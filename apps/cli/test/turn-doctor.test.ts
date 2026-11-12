import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, readTurnOwner, signOnTrap } from '@lobstah/core';
import { otherStopHooks, turnWaitsRow } from '../src/turn-doctor.js';
import { readTurnWaitRecords, syncTurnWaitRecords, turnWaitsDir } from '../src/turn-waits.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Doctor's `turn waits` row: every Stop hook that isn't lobstah's, whether its
 * tool has registered a wait with a trap, and the waits lobstah runs. It
 * names no tool.
 */

let dir: string;
let home: string;
const opts = () => ({ home, env: {} as NodeJS.ProcessEnv });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-turn-doctor-'));
  home = path.join(dir, 'user');
  process.env.LOBSTAH_HOME = path.join(dir, 'lobstah');
  process.env.AGENT_TURN_HOME = path.join(dir, 'agent-turn');
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  delete process.env.AGENT_TURN_HOME;
  removeTempDir(dir);
});

const stop = (command: string, timeout?: number) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] }] } });

/** A Claude Code home with lobstah and one other plugin whose Stop hook runs `command`. */
function claudeHome(command: string, timeout?: number): void {
  const claude = path.join(home, '.claude');
  const plugin = (name: string, hooks: object) => {
    const root = path.join(dir, 'plugins', name);
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(hooks));
    return root;
  };
  fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        'lobstah@lobstah': [{ installPath: plugin('lobstah', stop('lobstah hook stop', 14400)) }],
        'notes@acme': [{ installPath: plugin('notes', stop(command, timeout)) }],
      },
    }),
  );
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}');
}

/** What the other tool's Stop hook writes in a trap's session, once lobstah has picked it up. */
function registeredBy(tool: string): void {
  const worktree = path.join(dir, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const r = signOnTrap({ name: 'amber-gull', harness: 'claude', worktree, cwd: worktree, sessionId: 's-1', ttlMs: 60_000 });
  if (!('ok' in r)) throw new Error('held');
  fs.writeFileSync(path.join(readTurnOwner('s-1')!.waits, `${tool}.json`), JSON.stringify({ from: tool, wait: `${tool} wait`, read: `${tool} read` }));
  syncTurnWaitRecords();
}

describe('doctor: turn waits', () => {
  it('nothing to show: skip', () => {
    expect(turnWaitsRow(opts()).status).toBe('skip');
  });

  it("a long Stop hook whose tool never registered a wait warns; lobstah's own is not listed", () => {
    claudeHome('notes hook stop', 14400);
    expect(otherStopHooks(opts()).map((h) => h.source)).toEqual(['notes@acme']);
    const row = turnWaitsRow(opts());
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('claude notes@acme: `notes hook stop` (14400s), never registered a wait');
    expect(row.detail).toContain('notes@acme (claude) has a long Stop hook that has never registered a wait with a trap');
  });

  it('once its tool has registered a wait with a trap, the same hook is ok, and the wait shows', () => {
    claudeHome('notes hook stop', 14400);
    registeredBy('notes');
    const row = turnWaitsRow(opts());
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('`notes hook stop` (14400s), registers its wait');
    expect(row.detail).toMatch(/wait notes for amber-gull \(wt:[0-9a-f]{8}\): running/);
  });

  it('a short Stop hook is no risk', () => {
    claudeHome('notes hook stop', 5);
    expect(turnWaitsRow(opts()).status).toBe('ok');
  });

  it("a Codex plugin's Stop hook is read from its newest cached version", () => {
    const codex = path.join(home, '.codex');
    for (const [version, command] of [['1.0.0', 'old stop'], ['1.1.0', 'notes hook stop']] as const) {
      const root = path.join(codex, 'plugins', 'cache', 'acme', 'notes', version, 'hooks');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify(stop(command, 14400)));
    }
    fs.writeFileSync(path.join(codex, 'config.toml'), '[plugins."notes@acme"]\nenabled = true\n\n[plugins."lobstah@lobstah"]\nenabled = true\n');
    expect(otherStopHooks(opts())).toEqual([{ harness: 'codex', source: 'notes@acme', command: 'notes hook stop', timeout: 14400 }]);
  });

  it('a wait that keeps failing warns', () => {
    registeredBy('notes');
    const [record] = readTurnWaitRecords();
    fs.writeFileSync(path.join(turnWaitsDir(), fs.readdirSync(turnWaitsDir()).find((n) => n.endsWith('.json'))!), JSON.stringify({ ...record, failures: 3, lastError: 'engine down' }));
    const row = turnWaitsRow(opts());
    expect(row.status).toBe('warn');
    expect(row.detail).toMatch(/wait notes for amber-gull \(wt:[0-9a-f]{8}\): failing 3x: engine down/);
    expect(row.detail).toMatch(/notes for amber-gull \(wt:[0-9a-f]{8}\) keeps failing/);
  });
});
