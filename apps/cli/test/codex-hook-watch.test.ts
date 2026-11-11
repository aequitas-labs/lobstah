import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, listNotices, signOnTrap, type TrapRegistration } from '@lobstah/core';
import { codexPluginFingerprint, createCodexHookWatch } from '../src/codex-hook-watch.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-hook-watch-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

function codexTrap(name: string, over: Partial<TrapRegistration> = {}): void {
  const worktree = path.join(home, name);
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'web', harness: 'codex', sessionId: `${name}-thread`, ttlMs: 60_000, ...over });
  if (!('ok' in signed)) throw new Error('unexpected hold');
}
const stale = () => listNotices(50).filter((n) => n.kind === 'codex-hooks-stale');

describe("when lobstah's Codex plugin changes", () => {
  it('refreshes trust for shared-server traps, and tells the helm once which TUI traps need a re-throw', async () => {
    codexTrap('server-trap', { codexServer: true });
    codexTrap('tui-trap');
    let plugin = 'v1';
    const refreshServerTrust = vi.fn(async () => {});
    const watch = createCodexHookWatch({ fingerprint: () => plugin, refreshServerTrust });
    const later = Date.now() + 60_000;
    // The first look only records what is installed.
    expect(watch(later, () => {})).toBeUndefined();
    expect(watch(later, () => {})).toBeUndefined();
    plugin = 'v2';
    await watch(later, () => {});
    expect(refreshServerTrust.mock.calls.map(([trap]) => (trap as TrapRegistration).sessionId)).toEqual(['server-trap-thread']);
    expect(stale()).toHaveLength(1);
    expect(stale()[0]!.text).toContain('man throw');
    expect(watch(later, () => {})).toBeUndefined();
    expect(stale()).toHaveLength(1);
  });

  it('tries a failed refresh again on the next tick', async () => {
    codexTrap('server-trap', { codexServer: true });
    let plugin = 'v1';
    const refreshServerTrust = vi.fn().mockRejectedValueOnce(new Error('server starting')).mockResolvedValue(undefined);
    const watch = createCodexHookWatch({ fingerprint: () => plugin, refreshServerTrust });
    const later = Date.now() + 60_000;
    watch(later, () => {});
    plugin = 'v2';
    await watch(later, () => {});
    await watch(later, () => {});
    expect(refreshServerTrust).toHaveBeenCalledTimes(2);
    expect(watch(later, () => {})).toBeUndefined();
  });

  it("fingerprints the plugin's files, so any change to them shows", () => {
    const codexHome = path.join(home, 'codex');
    const root = path.join(codexHome, 'plugins', 'cache', 'lobstah', 'lobstah', '0.8.7');
    fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills', 'trap'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[plugins."lobstah@lobstah"]\nenabled = true\n');
    fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'lobstah', version: '0.8.7' }));
    fs.writeFileSync(path.join(root, 'skills', 'trap', 'SKILL.md'), 'one');
    const env = { CODEX_HOME: codexHome };
    const before = codexPluginFingerprint({ env });
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(codexPluginFingerprint({ env })).toBe(before);
    fs.writeFileSync(path.join(root, 'skills', 'trap', 'SKILL.md'), 'two');
    expect(codexPluginFingerprint({ env })).not.toBe(before);
    expect(codexPluginFingerprint({ env: { CODEX_HOME: path.join(home, 'none') } })).toBeUndefined();
  });
});
