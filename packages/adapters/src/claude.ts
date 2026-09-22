import { spawn } from 'node:child_process';
import { onPath } from '@lobstah/core';
import type { NormalizedEvent } from '@lobstah/core';
import { AsyncQueue, InputGate, now } from './types.js';
import type { Adapter, AdapterRun, AdapterStartOpts } from './types.js';

/** Parse verbatim `flags` into the SDK's extraArgs record (`--key value` pairs). */
function flagsToExtraArgs(flags: string[]): Record<string, string | null> {
  const extra: Record<string, string | null> = {};
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (!f?.startsWith('--')) continue;
    const next = flags[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      extra[f.slice(2)] = next;
      i++;
    } else {
      extra[f.slice(2)] = null;
    }
  }
  return extra;
}

interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  total_cost_usd?: number;
  message?: { content?: Array<{ type?: string; name?: string; text?: string }> };
}

/**
 * One stream-json message → normalized events. The SDK yields these objects
 * directly; the CLI prints them as NDJSON — same protocol (the SDK wraps the
 * CLI), so both paths share this pump.
 */
export function pumpClaudeMessage(
  msg: StreamMessage,
  push: (e: NormalizedEvent) => void,
  onSession: (id: string) => void,
): void {
  const at = now();
  if (msg.type === 'system' && msg.subtype === 'init') {
    if (msg.session_id) onSession(msg.session_id);
    push({ at, type: 'session', data: { sessionId: msg.session_id } });
  } else if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'tool_use') {
        push({ at, type: 'tool-start', data: { name: block.name } });
      } else if (block.type === 'text' && block.text) {
        push({ at, type: 'text', data: { text: String(block.text).slice(0, 2000) } });
      }
    }
  } else if (msg.type === 'user') {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') push({ at, type: 'tool-end', data: {} });
      }
    }
  } else if (msg.type === 'result') {
    push({ at, type: 'turn-end', data: { subtype: msg.subtype, costUsd: msg.total_cost_usd } });
  }
}

const userMessage = (content: string) => ({
  type: 'user',
  message: { role: 'user', content },
  parent_tool_use_id: null,
  session_id: '',
});

/** The headless invocation matching what the SDK path configures. */
export function claudeCliArgs(opts: AdapterStartOpts): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.limits.maxTurns) args.push('--max-turns', String(opts.limits.maxTurns));
  if (opts.resumeSession) args.push('--resume', opts.resumeSession, '--fork-session');
  args.push(...opts.flags);
  return args;
}

export interface CliInvocation {
  file: string;
  argvPrefix: string[];
}

/**
 * Drive the claude CLI directly over stream-json — the fallback when the
 * agent SDK is not importable (a compiled binary, or an npm install whose
 * optional SDK dependency failed). Same protocol, same normalization.
 */
export function startClaudeCli(invocation: CliInvocation, opts: AdapterStartOpts): AdapterRun {
  const child = spawn(invocation.file, [...invocation.argvPrefix, ...claudeCliArgs(opts)], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // .cmd shims need a shell to exec
  });
  const events = new AsyncQueue<NormalizedEvent>();
  const input = new InputGate();
  let sessionId: string | undefined;
  let stderrTail = '';
  child.stdin.on('error', () => {}); // a dead child makes writes EPIPE — exit handling owns it
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  child.stdin.write(`${JSON.stringify(userMessage(opts.prompt))}\n`);
  void (async () => {
    while (true) {
      const text = await input.next();
      if (text === undefined) break;
      child.stdin.write(`${JSON.stringify(userMessage(text))}\n`);
    }
    child.stdin.end();
  })();

  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        pumpClaudeMessage(JSON.parse(line) as StreamMessage, (e) => events.push(e), (id) => (sessionId = id));
      } catch {
        // interleaved non-JSON noise — the protocol lines are what matter
      }
    }
  });

  const done = new Promise<{ sessionId?: string; error?: string }>((resolve) => {
    child.on('error', (err) => {
      events.push({ at: now(), type: 'error', data: { message: err.message } });
      events.close();
      resolve({ sessionId, error: err.message });
    });
    child.on('exit', (code) => {
      events.close();
      if (code === 0) resolve({ sessionId });
      else {
        const detail = stderrTail.trim().split('\n').at(-1);
        const error = `claude exited ${code}${detail ? ` — ${detail}` : ''}`;
        resolve({ sessionId, error });
      }
    });
  });

  return {
    events,
    send: (text) => input.send(text),
    end: () => input.end(),
    done,
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort; the supervisor owns hard kills
      }
      input.end();
    },
  };
}

export function createClaudeAdapter(): Adapter {
  return {
    name: 'claude',
    async start(opts: AdapterStartOpts): Promise<AdapterRun> {
      let sdk: any;
      try {
        sdk = (await import('@anthropic-ai/claude-agent-sdk' as string)) as any;
      } catch (err) {
        if (onPath('claude')) return startClaudeCli({ file: 'claude', argvPrefix: [] }, opts);
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`claude adapter: agent SDK unavailable (${detail}) and no \`claude\` CLI on PATH`);
      }

      const input = new InputGate();
      async function* userMessages(): AsyncGenerator<unknown> {
        yield userMessage(opts.prompt);
        while (true) {
          const text = await input.next();
          if (text === undefined) return;
          yield userMessage(text);
        }
      }

      const q = sdk.query({
        prompt: userMessages(),
        options: {
          cwd: opts.cwd,
          model: opts.model,
          maxTurns: opts.limits.maxTurns,
          resume: opts.resumeSession,
          forkSession: opts.resumeSession ? true : undefined,
          permissionMode: 'bypassPermissions',
          env: { ...process.env, ...opts.env },
          extraArgs: flagsToExtraArgs(opts.flags),
        },
      });

      const events = new AsyncQueue<NormalizedEvent>();
      let sessionId: string | undefined;

      const done = (async () => {
        try {
          for await (const msg of q) {
            pumpClaudeMessage(msg as StreamMessage, (e) => events.push(e), (id) => (sessionId = id));
          }
          return { sessionId };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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
        kill: () => {
          try {
            q.interrupt?.();
          } catch {
            // best effort; the supervisor owns hard kills
          }
          input.end();
        },
      };
    },
  };
}
