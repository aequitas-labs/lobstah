import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { codexHookTrustToml, codexHookTrustValues, listCodexHooks, type CodexHookList, type CodexListedHook } from '../src/codex-hook-list.js';
import { codexTrapHookArgs } from '../src/codex-startup.js';
import { codexHooks } from '../src/hook-readiness.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const HOOK_HASH = `sha256:${'a'.repeat(64)}`;
const CONTENT_HASH = `sha256:${'b'.repeat(64)}`;
const bundled = () => JSON.parse(fs.readFileSync(new URL('../../../plugins/codex/hooks/hooks.json', import.meta.url), 'utf8'));
const pluginKey = (event: string) => `lobstah@lobstah:hooks/hooks.json:${event}:0:0`;
const COMMANDS: Record<string, string> = {
  session_start: 'lobstah hook session-start',
  user_prompt_submit: 'lobstah hook user-prompt-submit',
  post_tool_use: 'lobstah hook post-tool-use',
  pre_tool_use: 'lobstah hook pre-tool-use',
  permission_request: 'lobstah hook permission-request',
  stop: 'lobstah hook stop',
  session_end: 'lobstah hook session-end',
};

/** What Codex 0.166 reports: a two-part hash for every lobstah plugin hook. */
const listing = (fields: Partial<CodexListedHook> = {}): CodexHookList =>
  new Map(Object.entries(COMMANDS).map(([event, command]) => [pluginKey(event), { key: pluginKey(event), command, currentHash: `${HOOK_HASH}/${CONTENT_HASH}`, trustStatus: 'modified', ...fields }]));

let home: string;
let cwd: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-hook-list-'));
  cwd = path.join(home, 'checkout');
  fs.mkdirSync(cwd);
  const root = path.join(home, 'plugins', 'cache', 'lobstah', 'lobstah', '0.8.4');
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), '{"name":"lobstah","version":"0.8.4"}');
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(bundled()));
  fs.writeFileSync(path.join(home, 'config.toml'), '[plugins."lobstah@lobstah"]\nenabled=true\n');
});
afterEach(() => removeTempDir(home));

const stateFrom = (args: string[]) => (parse(args[1]!) as { hooks: { state: Record<string, Record<string, string>> } }).hooks.state;

describe('the trust values in a Codex hook hash', () => {
  it('splits a two-part hash into the two fields Codex stores', () => {
    expect(codexHookTrustValues(`${HOOK_HASH}/${CONTENT_HASH}`)).toEqual({ trusted_hash: HOOK_HASH, trusted_content_hash: CONTENT_HASH });
  });

  it('keeps a one-part hash, from Codex before 0.166, as one field', () => {
    expect(codexHookTrustValues(HOOK_HASH)).toEqual({ trusted_hash: HOOK_HASH });
  });

  it('writes one inline TOML table', () => {
    expect(codexHookTrustToml({ trusted_hash: 'x', trusted_content_hash: 'y' })).toBe('{trusted_hash="x",trusted_content_hash="y"}');
  });
});

describe('a thrown trap trusts its hooks with the hash Codex reports', () => {
  it('supplies both fields for every lobstah hook on Codex 0.166', () => {
    const state = stateFrom(codexTrapHookArgs({ env: { CODEX_HOME: home }, cwd, listed: listing() }));
    expect(Object.keys(state)).toHaveLength(7);
    for (const entry of Object.values(state)) expect(entry).toEqual({ trusted_hash: HOOK_HASH, trusted_content_hash: CONTENT_HASH });
  });

  it('computes the hook hash itself when Codex can not answer', () => {
    const state = stateFrom(codexTrapHookArgs({ env: { CODEX_HOME: home }, cwd }));
    for (const entry of Object.values(state)) expect(entry).toEqual({ trusted_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
  });

  it('refuses when Codex reports a different command for a lobstah hook', () => {
    const tampered = new Map(listing());
    tampered.set(pluginKey('stop'), { ...tampered.get(pluginKey('stop'))!, command: 'lobstah hook stop; echo unexpected' });
    expect(() => codexTrapHookArgs({ env: { CODEX_HOME: home }, cwd, listed: tampered })).toThrow(/cannot authorize Stop/);
  });

  it('trusts only lobstah hooks, whatever else Codex lists', () => {
    const other = new Map(listing());
    other.set('/some/hooks.json:stop:0:0', { key: '/some/hooks.json:stop:0:0', command: 'rm -rf /', currentHash: HOOK_HASH, trustStatus: 'untrusted' });
    const state = stateFrom(codexTrapHookArgs({ env: { CODEX_HOME: home }, cwd, listed: other }));
    expect(Object.keys(state).every((key) => key.startsWith('lobstah@lobstah:'))).toBe(true);
  });
});

describe('doctor reads hook trust from Codex when it can', () => {
  it('reports changed when Codex says modified, even with a matching trusted_hash in config', () => {
    const report = codexHooks({ env: { CODEX_HOME: home }, listed: listing() });
    expect(report.hooks.length).toBeGreaterThan(0);
    expect(report.hooks.every((hook) => hook.trusted === 'changed')).toBe(true);
  });

  it('reports trusted when Codex says trusted', () => {
    const report = codexHooks({ env: { CODEX_HOME: home }, listed: listing({ trustStatus: 'trusted' }) });
    expect(report.hooks.every((hook) => hook.trusted === 'trusted')).toBe(true);
  });

  it('falls back to reading config when Codex can not answer', () => {
    const report = codexHooks({ env: { CODEX_HOME: home } });
    expect(report.hooks.every((hook) => hook.trusted === 'untrusted')).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('asking Codex over its own protocol', () => {
  let savedPath: string | undefined;
  const fakeCodex = (script: string): void => {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\n${script}\n`);
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  };
  beforeEach(() => { savedPath = process.env.PATH; });
  afterEach(() => { process.env.PATH = savedPath; });

  it('reads the hook list from a real request and reply', async () => {
    const hook = { key: pluginKey('stop'), command: 'lobstah hook stop', currentHash: `${HOOK_HASH}/${CONTENT_HASH}`, trustStatus: 'modified' };
    const reply = JSON.stringify({ id: 2, result: { data: [{ hooks: [hook] }] } });
    fakeCodex(`while read -r line; do case "$line" in *'"hooks/list"'*) printf '%s\\n' '${reply}';; *'"initialize"'*) printf '%s\\n' '{"id":1,"result":{}}';; esac; done`);
    expect((await listCodexHooks(cwd))?.get(pluginKey('stop'))).toEqual(hook);
  });

  it('does not run the server inside the checkout, which Windows would then refuse to delete', async () => {
    const seen = path.join(home, 'server-cwd');
    fakeCodex(`pwd > ${JSON.stringify(seen)}; exit 1`);
    await listCodexHooks(cwd);
    expect(fs.realpathSync(fs.readFileSync(seen, 'utf8').trim())).not.toBe(fs.realpathSync(cwd));
  });

  it('keeps stdin open until the reply, because the real server exits when stdin closes', async () => {
    const reply = JSON.stringify({ id: 2, result: { data: [{ hooks: [] }] } });
    // Like the real server: it answers a moment later, and exits first if stdin closes.
    fakeCodex(`read -r a; read -r b; read -r c; (/bin/sleep 0.3; printf '%s\\n' '${reply}') & while read -r d; do :; done; exit 0`);
    expect((await listCodexHooks(cwd))?.size).toBe(0);
  });

  it('stops waiting at its deadline', async () => {
    fakeCodex('/bin/sleep 30');
    const started = Date.now();
    expect(await listCodexHooks(cwd, { timeoutMs: 200 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it.each([
    ['exits at once', 'exit 1'],
    ['prints junk', 'echo not json'],
    ['answers an error', `while read -r line; do printf '%s\\n' '{"id":2,"error":{"message":"unknown method"}}'; done`],
    ['answers no hooks field', `while read -r line; do printf '%s\\n' '{"id":2,"result":{"data":[{}]}}'; done`],
  ])('returns undefined when Codex %s', async (_name, script) => {
    fakeCodex(script);
    expect(await listCodexHooks(cwd)).toBeUndefined();
  });
});
