import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { codexTrapHookArgs } from '../src/codex-startup.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let root: string;
let config: string;
const bundled = () => JSON.parse(fs.readFileSync(new URL('../../../plugins/codex/hooks/hooks.json', import.meta.url), 'utf8'));
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-start-'));
  root = path.join(home, 'plugins', 'cache', 'lobstah', 'lobstah', '0.7.11');
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), '{"name":"lobstah","version":"0.7.11"}');
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(bundled()));
  config = path.join(home, 'config.toml');
  fs.writeFileSync(config, '[plugins."lobstah@lobstah"]\nenabled=true\n[hooks.state."repo:stop:0:0"]\ntrusted_hash="user-owned"\nenabled=false\n[hooks.state."lobstah@lobstah:hooks/hooks.json:stop:0:0"]\nenabled=false\n');
});
afterEach(() => removeTempDir(home));
const args = () => codexTrapHookArgs({ env: { CODEX_HOME: home } });

describe('Codex trap startup trust', () => {
  it('scopes six current hook hashes to the invocation, preserving user config and enablement', () => {
    const before = fs.readFileSync(config, 'utf8');
    const overrides = args();
    expect(overrides[0]).toBe('-c');
    const state = (parse(overrides[1]!) as any).hooks.state;
    expect(Object.keys(state)).toHaveLength(6);
    expect(Object.keys(state).every((k) => k.startsWith('lobstah@lobstah:hooks/hooks.json:'))).toBe(true);
    for (const entry of Object.values(state)) expect(entry).toEqual({ trusted_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(state).not.toHaveProperty('repo:stop:0:0');
    expect(fs.readFileSync(config, 'utf8')).toBe(before);
    expect(overrides.join(' ')).not.toContain('bypass');
  });

  it.each([
    ['suffix', (h: any) => { h.hooks.Stop[0].hooks[0].command += '; echo unexpected'; }],
    ['Windows command', (h: any) => { h.hooks.Stop[0].hooks[0].commandWindows = 'echo unexpected'; }],
    ['unknown event', (h: any) => { h.hooks.PreToolUse = h.hooks.Stop; }],
    ['other handler type', (h: any) => { h.hooks.Stop[0].hooks[0].type = 'prompt'; }],
  ])('refuses an unrecognized plugin definition: %s', (_, alter) => {
    const hooks = bundled();
    alter(hooks);
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(hooks));
    expect(args).toThrow(/cannot authorize/);
  });

  it('does not enable an absent or disabled plugin', () => {
    fs.writeFileSync(config, '[plugins."lobstah@lobstah"]\nenabled=false\n');
    expect(args()).toEqual([]);
    fs.writeFileSync(config, '');
    expect(args()).toEqual([]);
  });
});
