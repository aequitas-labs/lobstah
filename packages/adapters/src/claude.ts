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

export function createClaudeAdapter(): Adapter {
  return {
    name: 'claude',
    async start(opts: AdapterStartOpts): Promise<AdapterRun> {
      const sdk = (await import('@anthropic-ai/claude-agent-sdk' as string)) as any;

      const input = new InputGate();
      async function* userMessages(): AsyncGenerator<unknown> {
        yield {
          type: 'user',
          message: { role: 'user', content: opts.prompt },
          parent_tool_use_id: null,
          session_id: '',
        };
        while (true) {
          const text = await input.next();
          if (text === undefined) return;
          yield {
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            session_id: '',
          };
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
            const at = now();
            if (msg.type === 'system' && msg.subtype === 'init') {
              sessionId = msg.session_id;
              events.push({ at, type: 'session', data: { sessionId } });
            } else if (msg.type === 'assistant') {
              for (const block of msg.message?.content ?? []) {
                if (block.type === 'tool_use') {
                  events.push({ at, type: 'tool-start', data: { name: block.name } });
                } else if (block.type === 'text' && block.text) {
                  events.push({ at, type: 'text', data: { text: String(block.text).slice(0, 2000) } });
                }
              }
            } else if (msg.type === 'user') {
              const content = msg.message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_result') events.push({ at, type: 'tool-end', data: {} });
                }
              }
            } else if (msg.type === 'result') {
              events.push({ at, type: 'turn-end', data: { subtype: msg.subtype, costUsd: msg.total_cost_usd } });
            }
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
