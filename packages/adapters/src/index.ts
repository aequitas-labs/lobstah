import type { Adapter } from './types.js';
import { createClaudeAdapter } from './claude.js';
import { createCodexAdapter } from './codex.js';

export * from './types.js';
export { createClaudeAdapter } from './claude.js';
export { createCodexAdapter } from './codex.js';

export function loadAdapter(name: string): Adapter {
  switch (name) {
    case 'claude':
      return createClaudeAdapter();
    case 'codex':
      return createCodexAdapter();
    default:
      throw new Error(`unknown harness "${name}" — known: claude, codex`);
  }
}
