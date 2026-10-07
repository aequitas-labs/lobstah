import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@lobstah/core';
import { pumpClaudeMessage } from '../src/claude.js';
import { pumpCodexEvent } from '../src/codex.js';

const TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

describe('adapters put the primary target, never the input, into the stream', () => {
  it('Claude init records the observed local model, including custom identifiers', () => {
    const seen: NormalizedEvent[] = [];
    pumpClaudeMessage({ type: 'system', subtype: 'init', session_id: 's', model: 'custom/model' }, (e) => seen.push(e), () => {});
    expect(seen[0]?.data).toEqual({ sessionId: 's', model: 'custom/model' });
  });
  it('claude: tool_use carries a target; thinking carries no content', () => {
    const seen: NormalizedEvent[] = [];
    pumpClaudeMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', text: `use ${TOKEN}` },
            { type: 'tool_use', name: 'Bash', input: { command: `GH_TOKEN=${TOKEN} gh pr create --body x` } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/wt/src/a.ts', new_string: TOKEN } },
          ],
        },
      },
      (e) => seen.push(e),
      () => {},
    );
    expect(seen.map((e) => [e.type, e.data])).toEqual([
      ['thinking', {}],
      ['tool-start', { name: 'Bash', target: 'gh' }],
      ['tool-start', { name: 'Edit', target: '/wt/src/a.ts' }],
    ]);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  it('codex: command items carry the first word; reasoning is thinking', () => {
    const seen: NormalizedEvent[] = [];
    const push = (e: NormalizedEvent) => seen.push(e);
    pumpCodexEvent({ type: 'item.started', item: { type: 'command_execution', command: `bash -lc 'TOKEN=${TOKEN} pnpm test'` } }, push, () => {});
    pumpCodexEvent({ type: 'item.started', item: { type: 'file_change', changes: [{ path: '/wt/b.ts' }] } }, push, () => {});
    pumpCodexEvent({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'linear', tool: 'get_issue' } }, push, () => {});
    pumpCodexEvent({ type: 'item.started', item: { type: 'reasoning', text: TOKEN } }, push, () => {});
    expect(seen.map((e) => [e.type, e.data])).toEqual([
      ['tool-start', { name: 'command_execution', target: 'pnpm' }],
      ['tool-start', { name: 'file_change', target: '/wt/b.ts' }],
      ['tool-start', { name: 'mcp_tool_call', target: 'linear.get_issue' }],
      ['thinking', {}],
    ]);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });
});
