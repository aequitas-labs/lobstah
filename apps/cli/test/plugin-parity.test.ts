import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p: string) => fs.readFileSync(`${root}/${p}`, 'utf8');

/**
 * The Claude Code and Codex plugin layouts ship the same content by copy —
 * there is no build step between the repo and a marketplace install. This
 * guard is the sync mechanism: an edit to one side fails here until the
 * other side matches.
 */
describe('plugin parity (claude-code ↔ codex)', () => {
  it('the lobsterman skill is byte-identical in both plugins', () => {
    expect(read('plugins/codex/skills/lobsterman/SKILL.md')).toBe(
      read('plugins/claude-code/skills/lobsterman/SKILL.md'),
    );
  });

  it('both plugins wire the same hook commands', () => {
    const commands = (raw: string): Record<string, string[]> => {
      const parsed = JSON.parse(raw) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      return Object.fromEntries(
        Object.entries(parsed.hooks).map(([event, groups]) => [
          event,
          groups.flatMap((g) => g.hooks.map((h) => h.command)),
        ]),
      );
    };
    expect(commands(read('plugins/codex/hooks/hooks.json'))).toEqual(
      commands(read('plugins/claude-code/hooks/hooks.json')),
    );
  });
});
