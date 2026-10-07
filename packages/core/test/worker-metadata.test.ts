import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, observeSessionWorker, sessionWorker, signOnTrap, takeHelm, readHelm, readTrap, listNotices, workerLabel, workerMetadata } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lob-worker-')); process.env.LOBSTAH_HOME = home; ensureLayout(); });
afterEach(() => { removeTempDir(home); delete process.env.LOBSTAH_HOME; });
describe('local worker observations', () => {
  for (const harness of ['claude', 'codex']) {
    it(`${harness}: seeds registrations at sign-on and refreshes both roles mid-session`, () => {
      observeSessionWorker({ session_id: 's', hook_event_name: 'SessionStart', model: 'my-provider/custom-model', permission_mode: 'plan' }, harness);
      const worktree = path.join(home, 'wt'); fs.mkdirSync(worktree);
      const signed = signOnTrap({ sessionId: 's', harness, worktree, cwd: worktree, ttlMs: 60_000 });
      if (!('ok' in signed)) throw Error('hold');
      takeHelm({ sessionId: 's', grounds: { name: 'fleet', repos: [] }, ttlMs: 60_000, identity: { harness } });
      const expected = { harness, model: 'my-provider/custom-model', config: { effort: null, permissionMode: 'plan' } };
      expect(signed.ok).toMatchObject(expected);
      expect(readHelm('fleet')).toMatchObject(expected);
      expect(listNotices().find((n) => n.kind === 'trap-signed-on')?.text).toContain(workerLabel(expected));
      observeSessionWorker({ session_id: 's', hook_event_name: 'PostToolUse', model: 'new-model', permission_mode: 'acceptEdits' }, harness);
      expect(readTrap(signed.ok.trapId)).toMatchObject({ model: 'new-model', config: { effort: null, permissionMode: 'acceptEdits' }, signedOnAt: signed.ok.signedOnAt });
      expect(readHelm('fleet')?.model).toBe('new-model');
      observeSessionWorker({ session_id: 's', hook_event_name: 'SubagentStart', model: 'child-model' }, harness);
      observeSessionWorker({ session_id: 's', hook_event_name: 'Stop' }, harness);
      expect(readHelm('fleet')?.model).toBe('new-model');
      observeSessionWorker({ session_id: 's', hook_event_name: 'SessionStart' }, harness);
      expect(readTrap(signed.ok.trapId)).toMatchObject({ model: null, config: { effort: null, permissionMode: null } });
    });
  }
  it('unknown stays null; config accepts only fixed choices; local model IDs are bounded, not cataloged', () => {
    expect(workerMetadata()).toEqual({ harness: null, model: null, config: { effort: null, permissionMode: null } });
    expect(workerMetadata({ model: 'private-model', config: { effort: 'high', permissionMode: 'plan' } }).model).toBe('private-model');
    for (const model of ['secret\ntext', 'x'.repeat(129), {}, '/tmp/model']) expect(workerMetadata({ model }).model).toBeNull();
    expect(workerMetadata({ config: { effort: 'secret', permissionMode: 'secret' } }).config).toEqual({ effort: null, permissionMode: null });
    observeSessionWorker({ session_id: '../escape', model: 'x' }, 'claude');
    expect(sessionWorker('../escape', 'claude').model).toBeNull();
  });
});
