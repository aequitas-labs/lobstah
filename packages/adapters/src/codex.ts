import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { codexInvocation, lobstahHome } from '@lobstah/core';
import type { NormalizedEvent } from '@lobstah/core';
import { AsyncQueue, InputGate, now } from './types.js';
import type { Adapter, AdapterRun, AdapterStartOpts } from './types.js';

/**
 * Dispatches inherit auth but never interactive config: the operator's MCP
 * servers (often OAuth-gated) can hard-kill a headless run, and TOML config
 * merging cannot subtract them. A lobstah-managed CODEX_HOME gives every
 * dispatch a clean config while auth.json stays a symlink to the real one, so
 * token refresh writes through. Mirrors the Claude SDK, which loads no user
 * settings by default.
 */
function isolatedCodexHome(): string {
  const dir = path.join(lobstahHome(), 'codex-home');
  fs.mkdirSync(dir, { recursive: true });
  const auth = path.join(dir, 'auth.json');
  const realAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(auth) && fs.existsSync(realAuth)) {
    try {
      fs.symlinkSync(realAuth, auth);
    } catch {
      fs.copyFileSync(realAuth, auth); // Windows without symlink rights
    }
  }
  const cfg = path.join(dir, 'config.toml');
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, '# lobstah-managed: auth inherited from ~/.codex, interactive config not' + '\n');
  }
  return dir;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  error?: { message?: string };
}

/**
 * One codex thread event → normalized events. The SDK yields these objects;
 * `codex exec --json` prints the same stream as NDJSON — shared pump.
 * Returns a turn-failure message when the event carries one.
 */
export function pumpCodexEvent(
  ev: CodexEvent,
  push: (e: NormalizedEvent) => void,
  onSession: (id: string) => void,
): string | undefined {
  const at = now();
  if (ev.type === 'thread.started') {
    if (ev.thread_id) onSession(ev.thread_id);
    push({ at, type: 'session', data: { sessionId: ev.thread_id } });
  } else if (ev.type === 'turn.started') {
    push({ at, type: 'turn-start', data: {} });
  } else if (ev.type === 'item.started') {
    push({ at, type: 'tool-start', data: { name: ev.item?.type } });
  } else if (ev.type === 'item.completed') {
    if (ev.item?.type === 'agent_message' && ev.item?.text) {
      push({ at, type: 'text', data: { text: String(ev.item.text).slice(0, 2000) } });
    } else {
      push({ at, type: 'tool-end', data: { name: ev.item?.type } });
    }
  } else if (ev.type === 'turn.failed') {
    const message = ev.error?.message ?? 'turn failed';
    push({ at, type: 'error', data: { message } });
    return message;
  }
  return undefined;
}

/** One headless turn's argv: `codex exec [resume <thread>] --json ... <prompt>`. */
export function codexExecArgs(opts: AdapterStartOpts, prompt: string, resumeThread?: string): string[] {
  const args = ['exec'];
  if (resumeThread) args.push('resume', resumeThread);
  args.push('--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--cd', opts.cwd);
  if (opts.model) args.push('-m', opts.model);
  if (opts.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`);
  args.push(prompt);
  return args;
}

/**
 * Drive the codex CLI over `exec --json` — the fallback when the codex SDK
 * is not importable (a compiled binary, or an npm install whose optional SDK
 * dependency failed). Each turn is one process; between-turn input resumes
 * the thread, mirroring the SDK's thread.run() loop.
 */
export function startCodexCli(
  invoke: (argv: string[]) => { file: string; argv: string[] },
  opts: AdapterStartOpts,
): AdapterRun {
  const input = new InputGate();
  const events = new AsyncQueue<NormalizedEvent>();
  let sessionId: string | undefined;
  let current: ReturnType<typeof spawn> | undefined;
  let killed = false;

  function runTurn(prompt: string, resumeThread?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const inv = invoke(codexExecArgs(opts, prompt, resumeThread));
      const child = spawn(inv.file, inv.argv, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, CODEX_HOME: isolatedCodexHome() },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32' && inv.file !== process.execPath,
      });
      current = child;
      let turnError: string | undefined;
      let stderrTail = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-2000);
      });
      let buf = '';
      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const failed = pumpCodexEvent(JSON.parse(line) as CodexEvent, (e) => events.push(e), (id) => (sessionId = id));
            if (failed) turnError = failed;
          } catch {
            // non-JSON noise between protocol lines
          }
        }
      });
      child.on('error', (err) => resolve(err.message));
      child.on('exit', (code) => {
        if (turnError) return resolve(turnError);
        if (code === 0 || killed) return resolve(undefined);
        const detail = stderrTail.trim().split('\n').at(-1);
        resolve(`codex exited ${code}${detail ? ` — ${detail}` : ''}`);
      });
    });
  }

  const done = (async () => {
    try {
      let next: string | undefined = opts.prompt;
      let thread = opts.resumeSession;
      while (next !== undefined && !killed) {
        const error = await runTurn(next, thread);
        thread = sessionId ?? thread;
        if (error) {
          events.push({ at: now(), type: 'error', data: { message: error } });
          return { sessionId, error };
        }
        events.push({ at: now(), type: 'turn-end', data: {} });
        next = await input.next();
      }
      return { sessionId };
    } finally {
      events.close();
    }
  })();

  return {
    events,
    send: (text) => input.send(text),
    end: () => input.end(),
    done,
    kill: () => {
      killed = true;
      try {
        current?.kill('SIGKILL');
      } catch {
        // best effort; the supervisor owns hard kills
      }
      input.end();
    },
  };
}

/**
 * Codex adapter. Between-turn input runs `thread.run()` again on the same
 * thread. Codex has no interception surface, so the lobstah MCP tools are
 * unavailable here — status arrives through the CLI write path instead
 * (`lobstah report`), which the injected contract tells the agent to use.
 */
export function createCodexAdapter(): Adapter {
  return {
    name: 'codex',
    async start(opts: AdapterStartOpts): Promise<AdapterRun> {
      let mod: any;
      try {
        mod = (await import('@openai/codex-sdk' as string)) as any;
      } catch (err) {
        if (codexInvocation([])) return startCodexCli((argv) => codexInvocation(argv)!, opts);
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`codex adapter: SDK unavailable (${detail}) and no codex CLI found (PATH or vendored)`);
      }
      const codex = new mod.Codex({
        env: { ...process.env, ...opts.env, CODEX_HOME: isolatedCodexHome() },
      });
      // The SDK defaults to a read-only sandbox; a dispatch owns its worktree.
      const threadOptions = {
        workingDirectory: opts.cwd,
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { modelReasoningEffort: opts.effort } : {}),
      };
      const thread = opts.resumeSession
        ? codex.resumeThread(opts.resumeSession, threadOptions)
        : codex.startThread(threadOptions);

      const input = new InputGate();
      const events = new AsyncQueue<NormalizedEvent>();
      let sessionId: string | undefined;
      let lastTurnError: string | undefined;

      const done = (async () => {
        try {
          let next: string | undefined = opts.prompt;
          while (next !== undefined) {
            const streamed = await thread.runStreamed(next);
            for await (const ev of streamed.events) {
              const failed = pumpCodexEvent(ev as CodexEvent, (e) => events.push(e), (id) => (sessionId = id));
              if (failed) lastTurnError = failed;
            }
            events.push({ at: now(), type: 'turn-end', data: {} });
            next = await input.next();
          }
          return { sessionId };
        } catch (err) {
          // The turn-level error names the cause (quota, auth); the process
          // exit message does not. Prefer the specific one.
          const message = lastTurnError ?? (err instanceof Error ? err.message : String(err));
          events.push({ at: now(), type: 'error', data: { message } });
          return { sessionId, error: message };
        } finally {
          events.close();
        }
      })();

      return {
        events,
        send: (text) => input.send(text),
        end: () => input.end(),
        done,
        kill: () => input.end(),
      };
    },
  };
}
