import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p: string) => fs.readFileSync(`${root}/${p}`, 'utf8').replace(/\r\n/g, '\n');

/**
 * The plugins share skill metadata and hook commands, but their instructions
 * can differ when their Stop-hook behavior differs.
 */
describe('plugin contracts (claude-code ↔ codex)', () => {
  it.each(['man', 'trap'])('the %s skill shares frontmatter in both plugins', (skill) => {
    const frontmatter = (raw: string) => raw.match(/^---\n[\s\S]*?\n---/)?.[0];
    expect(frontmatter(read(`plugins/codex/skills/${skill}/SKILL.md`))).toBe(
      frontmatter(read(`plugins/claude-code/skills/${skill}/SKILL.md`)),
    );
  });

  it('names the orchestrator skill man in both plugins', () => {
    for (const plugin of ['codex', 'claude-code']) {
      expect(read(`plugins/${plugin}/skills/man/SKILL.md`)).toMatch(/^---\nname: man\n/);
      expect(fs.existsSync(`${root}/plugins/${plugin}/skills/lobsterman/SKILL.md`)).toBe(false);
    }
    expect(fs.existsSync(`${root}/docs/lobsterman.md`)).toBe(false);
  });

  it('each skill stays under 80 lines', () => {
    for (const skill of ['man', 'trap']) {
      expect(read(`plugins/claude-code/skills/${skill}/SKILL.md`).trimEnd().split('\n').length).toBeLessThan(80);
    }
  });

  it('each plugin ships its own README for the registry listing', () => {
    // Split on purpose: the listings differ per harness (the /lobstah
    // command, Codex's trust review) — only presence is enforced.
    expect(read('plugins/codex/README.md')).toContain('lobstah for Codex');
    expect(read('plugins/claude-code/README.md')).toContain('lobstah for Claude Code');
  });

  it('Claude slash commands are namespaced in user-facing text', () => {
    const commands = 'plugins/claude-code/commands';
    expect(fs.existsSync(`${root}/${commands}/tend.md`)).toBe(true);
    expect(fs.existsSync(`${root}/${commands}/lobstah.md`)).toBe(false);
    const files = [
      'README.md', 'docs/man.md', 'plugins/claude-code/README.md',
      'plugins/claude-code/skills/man/SKILL.md',
      'plugins/claude-code/skills/trap/SKILL.md',
      ...fs.readdirSync(`${root}/${commands}`).filter((name) => name.endsWith('.md')).map((name) => `${commands}/${name}`),
      ...fs.readdirSync(`${root}/apps/cli/src`).filter((name) => name.endsWith('.ts')).map((name) => `apps/cli/src/${name}`),
    ];
    for (const file of files) {
      expect(read(file).match(/(?<![\w:./-])\/(?:helm|soak|stow|relieve|tend)\b/g), file).toBeNull();
    }
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
