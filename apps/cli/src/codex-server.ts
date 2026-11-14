import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import WebSocket from 'ws';
import { atomicRenameSync, codexInvocation, listTraps, lobstahHome, uniqueTempPath, type TrapRegistration } from '@lobstah/core';
import { listCodexHooks, type CodexHookList } from './codex-hook-list.js';
import { codexTrapFolderTrust, codexTrapHookTrust } from './codex-startup.js';

/**
 * Codex's shared app-server: the daemon a trap attaches to with `--remote
 * unix://` so a paired phone and the trap's pane drive one thread. Several
 * traps share one process, so nothing here may stop or restart it.
 */

const CALL_TIMEOUT_MS = 10_000;
const SERVER_COMMAND_TIMEOUT_MS = 30_000;
/** Where the lobstah daemon remembers which server process it last saw. */
const SERVER_IDENTITY_FILE = 'codex-server-identity';

/** What a `man throw` needs from the environment it starts the server with. */
const SERVER_ENV_DROPPED = /^(CLAUDE|TMUX$|TMUX_|ITERM_|TERM_PROGRAM|TERM_SESSION_ID|KITTY_|WEZTERM_|LOBSTAH_TRAP_TICKET)/;

/** One request and its reply on a connection to the shared server. */
type CodexServerCall = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** How a thread was left when lobstah asked it to stop. */
export type CodexThreadStop = 'interrupted' | 'idle' | 'unreachable';

function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** The server's socket as a real path: the configured one is a symlink, and a long path can't be connected to. */
function codexServerSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return fs.realpathSync(path.join(codexHome(env), 'app-server-control', 'app-server-control.sock'));
  } catch {
    return undefined;
  }
}

/** Connect to the shared server, run `work`, and disconnect. Rejects when the server can't be reached. */
async function withCodexServer<T>(work: (call: CodexServerCall) => Promise<T>): Promise<T> {
  const socket = codexServerSocket();
  if (!socket) throw new Error('Codex app-server socket not found');
  const connection = new WebSocket(`ws+unix://${socket}:/rpc`);
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const call: CodexServerCall = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex app-server did not answer ${method}`));
      }, CALL_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      connection.send(JSON.stringify({ id, method, params }));
    });
  connection.on('message', (data) => {
    const reply = JSON.parse(String(data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    const waiting = reply.id !== undefined ? pending.get(reply.id) : undefined;
    if (!waiting) return;
    pending.delete(reply.id!);
    if (reply.error) waiting.reject(new Error(reply.error.message ?? 'Codex app-server refused the request'));
    else waiting.resolve(reply.result ?? {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      connection.once('open', resolve);
      connection.once('error', reject);
    });
    connection.on('error', () => {});
    await call('initialize', { clientInfo: { name: 'lobstah', title: 'lobstah', version: '0' }, capabilities: { experimentalApi: true } });
    connection.send(JSON.stringify({ method: 'initialized' }));
    return await work(call);
  } finally {
    connection.close();
  }
}

/** Run a `codex` management command. Its environment never names this session, tab or ticket. */
function runCodex(argv: string[]): { ok: boolean; stdout: string; detail: string } {
  const invocation = codexInvocation(argv);
  if (!invocation) return { ok: false, stdout: '', detail: 'codex is not installed' };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SERVER_ENV_DROPPED.test(key)));
  const result = spawnSync(invocation.file, invocation.argv, { encoding: 'utf8', env, timeout: SERVER_COMMAND_TIMEOUT_MS });
  return { ok: result.status === 0, stdout: result.stdout ?? '', detail: (result.stderr || result.error?.message || `exited ${result.status}`).trim() };
}

/**
 * Make sure the shared server is up, with remote control on. `codex
 * remote-control start` restarts a running server, which would interrupt every
 * trap on it, so it only ever runs when none is running. A server this starts
 * inherits nothing that names the calling session, or a trap's tools would
 * read another session's id.
 */
export async function ensureCodexServer(): Promise<void> {
  const version = runCodex(['app-server', 'daemon', 'version']);
  let running = false;
  try {
    running = (JSON.parse(version.stdout) as { status?: string }).status === 'running';
  } catch {
    // No readable status: treat the server as down.
  }
  if (!running) {
    const started = runCodex(['remote-control', 'start', '--json']);
    if (!started.ok) throw new Error(`could not start Codex's shared server: ${started.detail}`);
    return;
  }
  const status = await withCodexServer((call) => call('remoteControl/status/read')).catch(() => undefined);
  if (status?.status !== 'disabled') return;
  const enabled = runCodex(['app-server', 'daemon', 'enable-remote-control']);
  if (!enabled.ok) throw new Error(`could not turn on remote control for Codex's shared server: ${enabled.detail}`);
}

/**
 * Set fields in one table of a TOML file's text, leaving every other line as
 * it is, including the table's other keys such as `enabled`. A missing table
 * goes at the end.
 */
export function setTomlTableFields(text: string, header: string, fields: Readonly<Record<string, string>>): string {
  const assignments = Object.entries(fields).map(([field, value]) => ({ field, line: `${field} = ${JSON.stringify(value)}` }));
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `[${header}]`);
  if (start < 0) {
    const base = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    return `${base}${base.trim() ? '\n' : ''}[${header}]\n${assignments.map((a) => a.line).join('\n')}\n`;
  }
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  for (const { field, line } of assignments) {
    const at = lines.findIndex((candidate, index) => index > start && index < end && new RegExp(`^\\s*${field}\\s*=`).test(candidate));
    if (at >= 0) {
      lines[at] = line;
    } else {
      lines.splice(start + 1, 0, line);
      end += 1;
    }
  }
  return lines.join('\n');
}

/**
 * Save what a trap on the shared server needs Codex to trust. `-c` flags on the
 * pane's TUI don't reach a server it attaches to, so this one trust has to be
 * in `config.toml`; the server reads it without a restart. It covers exactly
 * what a session flag would: lobstah's own vetted hook commands, committed
 * project hooks, and a lobstah-created worktree. An explicit untrusted folder
 * stays untrusted, and a hook's `enabled` setting isn't touched.
 */
export function trustForCodexServer(cwd: string, trapId: string, listed: CodexHookList | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const configFile = path.join(codexHome(env), 'config.toml');
  let text = '';
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const before = text;
  for (const { key, values } of codexTrapHookTrust({ env, cwd, listed })) text = setTomlTableFields(text, `hooks.state.${JSON.stringify(key)}`, { ...values });
  const { trustedPath } = codexTrapFolderTrust(cwd, trapId, { env });
  if (trustedPath) text = setTomlTableFields(text, `projects.${JSON.stringify(trustedPath)}`, { trust_level: 'trusted' });
  if (text === before) return;
  parse(text); // A result Codex couldn't read must never replace its config.
  const temporary = uniqueTempPath(configFile);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(temporary, text, { mode: fs.existsSync(configFile) ? fs.statSync(configFile).mode : 0o600 });
  atomicRenameSync(temporary, configFile);
}

/** Everything a thrown trap needs from the shared server before it attaches. */
export async function prepareCodexServer(cwd: string, trapId: string): Promise<void> {
  await ensureCodexServer();
  trustForCodexServer(cwd, trapId, await listCodexHooks(cwd));
}

/** Show a trap's name on the phone, instead of a title Codex made up. Best effort. */
export async function nameCodexThread(threadId: string, name: string): Promise<void> {
  await withCodexServer((call) => call('thread/name/set', { threadId, name })).catch(() => undefined);
}

/**
 * Stop a stowed trap's work on the shared server: interrupt its running turn
 * and let go of the thread. Never signals a process, because the server hosts
 * every other trap too.
 */
export async function stopCodexThread(threadId: string): Promise<CodexThreadStop> {
  try {
    return await withCodexServer(async (call) => {
      const { thread } = (await call('thread/read', { threadId, includeTurns: true })) as { thread?: { turns?: Array<{ id: string; status: string }> } };
      const running = [...(thread?.turns ?? [])].reverse().find((turn) => turn.status === 'inProgress');
      if (running) await call('turn/interrupt', { threadId, turnId: running.id });
      await call('thread/unsubscribe', { threadId }).catch(() => undefined);
      return running ? 'interrupted' : 'idle';
    });
  } catch {
    return 'unreachable';
  }
}

/** The turn that tells a trap its server restarted. */
export function codexRestartMessage(dispatchId?: string): string {
  const work = dispatchId ? `your assigned dispatch ${dispatchId}, if it isn't finished,` : 'any assigned work';
  return `lobstah: Codex's server restarted and interrupted your last turn. Any command that was running and your soak --wait listener were stopped. Carry on with ${work} from where it stopped, then listen again as usual.`;
}

/**
 * Start a turn on a trap's thread with `text`, unless a turn is already
 * running there (it would read the same thing soon anyway). 'started' or
 * 'busy'; throws when the server can't be reached.
 */
export async function startCodexTurn(threadId: string, text: string): Promise<'started' | 'busy'> {
  return withCodexServer(async (call) => {
    await call('thread/resume', { threadId });
    const { thread } = (await call('thread/read', { threadId, includeTurns: true })) as { thread?: { turns?: Array<{ status: string }> } };
    const busy = (thread?.turns ?? []).some((turn) => turn.status === 'inProgress');
    if (!busy) await call('turn/start', { threadId, input: [{ type: 'text', text }] });
    await call('thread/unsubscribe', { threadId }).catch(() => undefined);
    return busy ? 'busy' : 'started';
  });
}

/** Queue compaction on the existing thread; Codex serializes it with the thread's operations. */
export async function compactCodexThread(threadId: string): Promise<void> {
  await withCodexServer(async call => {
    await call('thread/resume', { threadId });
    await call('thread/compact/start', { threadId });
    await call('thread/unsubscribe', { threadId }).catch(() => undefined);
  });
}

/** Tell one trap its server restarted, by a turn on its own thread. */
async function wakeCodexTrap(trap: TrapRegistration): Promise<void> {
  await withCodexServer(async (call) => {
    await call('thread/resume', { threadId: trap.sessionId });
    await call('turn/start', { threadId: trap.sessionId, input: [{ type: 'text', text: codexRestartMessage(trap.claimed) }] });
    await call('thread/unsubscribe', { threadId: trap.sessionId }).catch(() => undefined);
  });
}

/** Which server process holds the socket: it changes when the server restarts. Undefined while it's down. */
function codexServerIdentity(): string | undefined {
  const socket = codexServerSocket();
  if (!socket) return undefined;
  try {
    const stat = fs.statSync(socket);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * The daemon's `codexServerWatch` hook. A server restart stops every running
 * turn on it and every listener its traps ran, and nothing else would wake
 * them, so each trap on the server is told once per restart. A restart counts
 * as handled only when every trap has been told: a server still starting up
 * refuses the first try, and the next tick tries the ones it refused.
 */
export function createCodexServerWatch(): (now: number, log: (message: string) => void) => void {
  let waking = false;
  let told = new Set<string>();
  return (_now, log) => {
    if (waking) return;
    const traps = listTraps().filter((trap) => trap.codexServer);
    if (traps.length === 0) return;
    const identity = codexServerIdentity();
    if (!identity) return;
    const file = path.join(lobstahHome(), SERVER_IDENTITY_FILE);
    let known: string | undefined;
    try {
      known = fs.readFileSync(file, 'utf8');
    } catch {
      // First look: nothing to compare with.
    }
    if (known === identity) return;
    if (known === undefined) {
      fs.writeFileSync(file, identity);
      return;
    }
    const waiting = traps.filter((trap) => !told.has(trap.trapId));
    waking = true;
    void Promise.all(waiting.map(async (trap) => {
      try {
        await wakeCodexTrap(trap);
        told.add(trap.trapId);
        log(`Codex's shared server restarted: woke trap ${trap.name ?? trap.trapId}`);
      } catch (error) {
        log(`could not wake trap ${trap.name ?? trap.trapId} after a Codex server restart, will retry: ${error instanceof Error ? error.message : String(error)}`);
      }
    })).then(() => {
      if (!traps.every((trap) => told.has(trap.trapId))) return;
      fs.writeFileSync(file, identity);
      told = new Set();
    }).finally(() => {
      waking = false;
    });
  };
}
