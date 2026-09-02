import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lobstahHome } from '@lobstah/core';
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
      const mod = (await import('@openai/codex-sdk' as string)) as any;
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
              const at = now();
              if (ev.type === 'thread.started') {
                sessionId = ev.thread_id;
                events.push({ at, type: 'session', data: { sessionId } });
              } else if (ev.type === 'turn.started') {
                events.push({ at, type: 'turn-start', data: {} });
              } else if (ev.type === 'item.started') {
                events.push({ at, type: 'tool-start', data: { name: ev.item?.type } });
              } else if (ev.type === 'item.completed') {
                if (ev.item?.type === 'agent_message' && ev.item?.text) {
                  events.push({ at, type: 'text', data: { text: String(ev.item.text).slice(0, 2000) } });
                } else {
                  events.push({ at, type: 'tool-end', data: { name: ev.item?.type } });
                }
              } else if (ev.type === 'turn.failed') {
                lastTurnError = ev.error?.message ?? 'turn failed';
                events.push({ at, type: 'error', data: { message: lastTurnError } });
              }
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
