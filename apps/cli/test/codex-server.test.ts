import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { WebSocketServer } from 'ws';
import { ensureLayout, listTraps, reservationForTicket, reserveTrap, signOnTrap, stowTrap, type TrapRegistration } from '@lobstah/core';
import { codexRestartMessage, createCodexServerWatch, setTomlTableFields, stopCodexThread, trustForCodexServer } from '../src/codex-server.js';
import type { CodexHookList } from '../src/codex-hook-list.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const bundled = () => JSON.parse(fs.readFileSync(new URL('../../../plugins/codex/hooks/hooks.json', import.meta.url), 'utf8'));
const HOOK_HASH = `sha256:${'a'.repeat(64)}`;
const CONTENT_HASH = `sha256:${'b'.repeat(64)}`;

let home: string;
let codexHome: string;
let socketDir: string;
/** Every request the fake server received. */
let received: Array<{ method: string; params: Record<string, unknown> }>;
/** Answers for particular methods; anything else gets an empty result. */
let answers: Map<string, (params: Record<string, unknown>) => unknown>;
let stopServer: (() => Promise<void>) | undefined;

/** A stand-in for Codex's shared server: WebSocket JSON-RPC on a Unix socket, behind the symlink Codex uses. */
const startServer = async (socketName = 's.sock'): Promise<void> => {
  const socket = path.join(socketDir, socketName);
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (connection) => {
    connection.on('message', (data) => {
      const request = JSON.parse(String(data)) as { id?: number; method: string; params?: Record<string, unknown> };
      if (request.id === undefined) return;
      received.push({ method: request.method, params: request.params ?? {} });
      try {
        const answer = answers.get(request.method)?.(request.params ?? {});
        connection.send(JSON.stringify({ id: request.id, result: answer ?? {} }));
      } catch (error) {
        connection.send(JSON.stringify({ id: request.id, error: { message: (error as Error).message } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const link = path.join(codexHome, 'app-server-control', 'app-server-control.sock');
  try {
    fs.unlinkSync(link);
  } catch {
    // No link yet.
  }
  fs.symlinkSync(socket, link);
  stopServer = async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
    stopServer = undefined;
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const methods = () => received.map((request) => request.method).filter((method) => method !== 'initialize');
const turns = () => received.filter((request) => request.method === 'turn/start');

const trap = (session: string, codexServer: boolean): TrapRegistration => {
  const worktree = path.join(home, `checkout-${session}`);
  fs.mkdirSync(worktree, { recursive: true });
  const signed = signOnTrap({ worktree, cwd: worktree, harness: 'codex', repo: 'r', sessionId: session, ttlMs: 60_000, ...(codexServer ? { codexServer: true } : {}) });
  if (!('ok' in signed)) throw new Error('unexpected hold');
  return signed.ok;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-server-'));
  codexHome = path.join(home, 'codex');
  socketDir = fs.mkdtempSync('/tmp/lcs-');
  fs.mkdirSync(path.join(codexHome, 'app-server-control'), { recursive: true });
  process.env.LOBSTAH_HOME = path.join(home, 'lobstah');
  process.env.CODEX_HOME = codexHome;
  ensureLayout();
  received = [];
  answers = new Map();
});
afterEach(async () => {
  await stopServer?.();
  delete process.env.LOBSTAH_HOME;
  delete process.env.CODEX_HOME;
  removeTempDir(home);
  fs.rmSync(socketDir, { recursive: true, force: true });
});

describe('editing one table of config.toml', () => {
  it('adds a table at the end, leaving the rest as it was', () => {
    const text = '# my settings\nmodel = "x"\n\n[other]\na = 1\n';
    expect(setTomlTableFields(text, 'projects."/w"', { trust_level: 'trusted' })).toBe(`${text}\n[projects."/w"]\ntrust_level = "trusted"\n`);
  });

  it('updates a field in place, and keeps the table\'s other keys', () => {
    const text = '[hooks.state."k"]\nenabled = false\ntrusted_hash = "old"\n\n[other]\ntrusted_hash = "not this one"\n';
    const out = setTomlTableFields(text, 'hooks.state."k"', { trusted_hash: 'new', trusted_content_hash: 'c' });
    expect(parse(out)).toEqual({ hooks: { state: { k: { enabled: false, trusted_hash: 'new', trusted_content_hash: 'c' } } }, other: { trusted_hash: 'not this one' } });
  });

  it('starts an empty file cleanly', () => {
    expect(setTomlTableFields('', 'a', { b: 'c' })).toBe('[a]\nb = "c"\n');
  });
});

describe('saving trust for the shared server', () => {
  const COMMANDS: Record<string, string> = {
    session_start: 'lobstah hook session-start',
    user_prompt_submit: 'lobstah hook user-prompt-submit',
    post_tool_use: 'lobstah hook post-tool-use',
    pre_tool_use: 'lobstah hook pre-tool-use',
    permission_request: 'lobstah hook permission-request',
    stop: 'lobstah hook stop',
    session_end: 'lobstah hook session-end',
  };
  const listing = (): CodexHookList => new Map(Object.entries(COMMANDS).map(([event, command]) => {
    const key = `lobstah@lobstah:hooks/hooks.json:${event}:0:0`;
    return [key, { key, command, currentHash: `${HOOK_HASH}/${CONTENT_HASH}`, trustStatus: 'modified' }];
  }));
  const config = () => path.join(codexHome, 'config.toml');
  type SavedConfig = { hooks: { state: Record<string, Record<string, unknown>> }; projects?: Record<string, unknown> };
  beforeEach(() => {
    const root = path.join(codexHome, 'plugins', 'cache', 'lobstah', 'lobstah', '0.8.4');
    fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'hooks'));
    fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), '{"name":"lobstah","version":"0.8.4"}');
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(bundled()));
    fs.writeFileSync(config(), '[plugins."lobstah@lobstah"]\nenabled = true\n');
  });

  it('saves both hash fields for each of lobstah\'s own hooks', () => {
    trustForCodexServer(home, 'trap', listing());
    const saved = parse(fs.readFileSync(config(), 'utf8')) as unknown as SavedConfig;
    expect(Object.keys(saved.hooks.state)).toHaveLength(7);
    for (const entry of Object.values(saved.hooks.state)) expect(entry).toEqual({ trusted_hash: HOOK_HASH, trusted_content_hash: CONTENT_HASH });
  });

  it('leaves a hook someone turned off turned off', () => {
    fs.appendFileSync(config(), '\n[hooks.state."lobstah@lobstah:hooks/hooks.json:stop:0:0"]\nenabled = false\n');
    trustForCodexServer(home, 'trap', listing());
    const saved = parse(fs.readFileSync(config(), 'utf8')) as unknown as SavedConfig;
    expect(saved.hooks.state['lobstah@lobstah:hooks/hooks.json:stop:0:0']).toMatchObject({ enabled: false, trusted_hash: HOOK_HASH });
  });

  it('saves nothing else, and no folder trust for a checkout lobstah did not create', () => {
    fs.appendFileSync(config(), '\n[hooks.state."/some/hooks.json:stop:0:0"]\ntrusted_hash = "theirs"\n');
    trustForCodexServer(home, 'trap', listing());
    const saved = parse(fs.readFileSync(config(), 'utf8')) as unknown as SavedConfig;
    expect(saved.hooks.state['/some/hooks.json:stop:0:0']).toEqual({ trusted_hash: 'theirs' });
    expect(saved.projects).toBeUndefined();
  });

  it('does not rewrite a config that already holds the trust', () => {
    trustForCodexServer(home, 'trap', listing());
    const first = fs.statSync(config()).ino;
    trustForCodexServer(home, 'trap', listing());
    expect(fs.statSync(config()).ino).toBe(first);
  });

  it('never touches a config it can not read', () => {
    const damaged = '[plugins."lobstah@lobstah"]\nenabled = true\nthis is not toml\n';
    fs.writeFileSync(config(), damaged);
    trustForCodexServer(home, 'trap', listing());
    expect(fs.readFileSync(config(), 'utf8')).toBe(damaged);
  });
});

describe('stopping a thread on the shared server', () => {
  it('interrupts a running turn and lets go of the thread', async () => {
    await startServer();
    answers.set('thread/read', () => ({ thread: { turns: [{ id: 'old', status: 'completed' }, { id: 'now', status: 'inProgress' }] } }));
    expect(await stopCodexThread('t1')).toBe('interrupted');
    expect(received.find((request) => request.method === 'turn/interrupt')?.params).toEqual({ threadId: 't1', turnId: 'now' });
    expect(methods()).toContain('thread/unsubscribe');
  });

  it('interrupts nothing on an idle thread', async () => {
    await startServer();
    answers.set('thread/read', () => ({ thread: { turns: [{ id: 'old', status: 'completed' }] } }));
    expect(await stopCodexThread('t1')).toBe('idle');
    expect(methods()).not.toContain('turn/interrupt');
  });

  it('says so when the server can not be reached', async () => {
    expect(await stopCodexThread('t1')).toBe('unreachable');
  });
});

describe('a trap on the shared server records no process of its own', () => {
  const process_ = { pid: 12345, startedAt: 'Thu Nov 5 01:03:13 2026' };
  const onServer = (extra: Record<string, unknown> = {}) => {
    const worktree = path.join(home, 'checkout');
    fs.mkdirSync(worktree, { recursive: true });
    const signed = signOnTrap({ worktree, cwd: worktree, harness: 'codex', repo: 'r', sessionId: 's', ttlMs: 60_000, ...extra });
    if (!('ok' in signed)) throw new Error('unexpected hold');
    return signed.ok;
  };

  it('drops the harness process a sign-on found, because that process is the server', () => {
    const reg = onServer({ codexServer: true, harnessProcess: process_ });
    expect(reg.codexServer).toBe(true);
    expect(reg.harnessProcess).toBeUndefined();
  });

  it('keeps that through a re-soak of the same session', () => {
    onServer({ codexServer: true });
    const again = onServer({ harnessProcess: process_ });
    expect(again.codexServer).toBe(true);
    expect(again.harnessProcess).toBeUndefined();
  });

  it('a plain Codex trap is unchanged', () => {
    const reg = onServer({ harnessProcess: process_ });
    expect(reg.codexServer).toBeUndefined();
    expect(reg.harnessProcess).toEqual(process_);
  });
});

describe('soak, for a reservation on the shared server', () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX_THREAD|TMUX|TERM_PROGRAM|ITERM_)/.test(key)));
    return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000, cwd: home, env: { ...clean, ...env } });
  };

  it('remember-window records the pane it runs in, and soak signs on with that window', () => {
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']]) spawnSync('git', args, { cwd: repo });
    const origin = path.join(home, 'origin.git');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: repo });
    spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(process.env.LOBSTAH_HOME!, 'config.toml'), `[repos.r]\npath = ${JSON.stringify(repo)}\ntrunk = "main"\n`);
    const { ticket } = reserveTrap({ repo: 'r', harness: 'codex', codexServer: true, startSecs: 60 });

    const remembered = run(['soak', 'remember-window', '--ticket', ticket], { TMUX_PANE: '%7', TMUX: '/tmp/tmux-sock,1,0' });
    expect(remembered.status, remembered.stderr).toBe(0);
    expect(reservationForTicket(ticket)?.window).toMatchObject({ tmuxPane: '%7', tmuxSocket: '/tmp/tmux-sock' });

    const signed = run(['soak', '--ticket', ticket, '--session', '01a1aa4d-e90f-77b3-83c5-5712b523bfff', '--harness', 'codex'], { TMUX_PANE: '%99', TMUX: '/tmp/other,1,0' });
    expect(signed.status, signed.stdout + signed.stderr).toBe(0);
    const [reg] = listTraps();
    expect(reg).toMatchObject({ codexServer: true, window: { tmuxPane: '%7' } });
    expect(reg!.harnessProcess).toBeUndefined();
  });

  it('remember-window says nothing about a ticket that redeems nothing, so the session still starts', () => {
    const result = run(['soak', 'remember-window', '--ticket', 'not-a-ticket']);
    expect(result.status).toBe(0);
  });
});

describe('the watch that wakes traps after a server restart', () => {
  const tick = async (watch: ReturnType<typeof createCodexServerWatch>, logs: string[] = []) => {
    watch(Date.now(), (message) => logs.push(message));
    await sleep(150);
    return logs;
  };
  const restart = async (name: string) => {
    await stopServer?.();
    await startServer(name);
  };

  it('does nothing with no trap on the server, and never connects', async () => {
    await startServer();
    trap('plain', false);
    const watch = createCodexServerWatch();
    await tick(watch);
    await restart('t.sock');
    await tick(watch);
    expect(received).toEqual([]);
  });

  it('only records the server on the first look', async () => {
    await startServer();
    trap('on-server', true);
    await tick(createCodexServerWatch());
    expect(turns()).toEqual([]);
  });

  it('wakes each trap on the server once per restart, on its own thread', async () => {
    await startServer();
    trap('one', true);
    trap('two', true);
    trap('plain', false);
    const watch = createCodexServerWatch();
    await tick(watch);
    await restart('t.sock');
    await tick(watch);
    expect(turns().map((request) => request.params.threadId).sort()).toEqual(['one', 'two']);
    await tick(watch);
    await tick(watch);
    expect(turns()).toHaveLength(2);
  });

  it('says which dispatch to carry on with', () => {
    expect(codexRestartMessage('d-1')).toContain('dispatch d-1');
    expect(codexRestartMessage()).toContain('any assigned work');
  });

  it('retries a trap the new server refused, without waking the others again', async () => {
    await startServer();
    trap('ok', true);
    trap('refused', true);
    const watch = createCodexServerWatch();
    await tick(watch);
    await restart('t.sock');
    let refusals = 1;
    answers.set('turn/start', (params) => {
      if (params.threadId === 'refused' && refusals-- > 0) throw new Error('server still starting');
      return {};
    });
    const logs = await tick(watch);
    expect(logs.join()).toContain('will retry');
    await tick(watch);
    const threads = turns().map((request) => request.params.threadId);
    expect(threads.filter((id) => id === 'ok')).toHaveLength(1);
    expect(threads.filter((id) => id === 'refused')).toHaveLength(2);
    await tick(watch);
    expect(turns()).toHaveLength(3);
  });

  it('waits while the server is down, and wakes once it is back', async () => {
    await startServer();
    trap('one', true);
    const watch = createCodexServerWatch();
    await tick(watch);
    await stopServer!();
    fs.rmSync(path.join(socketDir, 's.sock'), { force: true });
    await tick(watch);
    await startServer('t.sock');
    await tick(watch);
    expect(turns()).toHaveLength(1);
  });

  it('forgets a stowed trap', async () => {
    await startServer();
    const reg = trap('gone', true);
    const watch = createCodexServerWatch();
    await tick(watch);
    stowTrap(reg.trapId);
    await restart('t.sock');
    await tick(watch);
    expect(turns()).toEqual([]);
  });
});
