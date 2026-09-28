import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p: string) => fs.readFileSync(`${root}/${p}`, 'utf8').replace(/\r\n/g, '\n');

const harnessBlock = /<!-- harness-specific:start -->\n[\s\S]*?<!-- harness-specific:end -->\n/g;

function sharedSkillLines(raw: string): string[] {
  const starts = raw.match(/<!-- harness-specific:start -->/g)?.length ?? 0;
  const ends = raw.match(/<!-- harness-specific:end -->/g)?.length ?? 0;
  if (starts !== ends || starts !== [...raw.matchAll(harnessBlock)].length) {
    throw new Error('unpaired harness-specific skill block');
  }
  return raw.replace(harnessBlock, '').trimEnd().split('\n');
}

function differingLines(claude: string[], codex: string[]): string[] {
  return Array.from({ length: Math.max(claude.length, codex.length) }, (_, i) =>
    claude[i] === codex[i] ? null : `line ${i + 1}: claude=${JSON.stringify(claude[i])}, codex=${JSON.stringify(codex[i])}`,
  ).filter((line): line is string => line !== null);
}

type Hook = { type: string; command: string; timeout: number; statusMessage?: string };
type HookFile = { description: string; hooks: Record<string, Array<{ hooks: Hook[] }>> };

function sharedHooks(raw: string): HookFile['hooks'] {
  const parsed = JSON.parse(raw) as HookFile;
  // Declared harness differences: description; Codex SessionStart/Stop
  // statusMessage; SessionEnd timeout (Codex 3s, Claude 10s).
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (event === 'SessionStart' || event === 'Stop') delete hook.statusMessage;
        if (event === 'SessionEnd') delete (hook as Partial<Hook>).timeout;
      }
    }
  }
  return parsed.hooks;
}

describe('plugin contracts (claude-code ↔ codex)', () => {
  it.each(['man', 'trap'])('the %s skill has identical shared lines', (skill) => {
    const claude = sharedSkillLines(read(`plugins/claude-code/skills/${skill}/SKILL.md`));
    const codex = sharedSkillLines(read(`plugins/codex/skills/${skill}/SKILL.md`));
    expect(differingLines(claude, codex)).toEqual([]);
  });

  it('identifies a reverted shared skill line', () => {
    const claude = sharedSkillLines(read('plugins/claude-code/skills/man/SKILL.md'));
    const codex = sharedSkillLines(read('plugins/codex/skills/man/SKILL.md'));
    const reverted = codex.map((line) =>
      line.includes('finished work as a follow-up') ? line.replace('finished work as a follow-up', 'delivered between turns') : line,
    );
    expect(differingLines(claude, reverted)).toEqual([
      'line 28: claude="                                                  # finished work as a follow-up", codex="                                                  # delivered between turns"',
    ]);
  });

  it('names the orchestrator skill man in both plugins', () => {
    for (const plugin of ['codex', 'claude-code']) {
      expect(read(`plugins/${plugin}/skills/man/SKILL.md`)).toMatch(/^---\nname: man\n/);
      expect(fs.existsSync(`${root}/plugins/${plugin}/skills/lobsterman/SKILL.md`)).toBe(false);
    }
    expect(fs.existsSync(`${root}/docs/lobsterman.md`)).toBe(false);
  });

  it('each skill stays under 100 lines including harness-specific blocks', () => {
    for (const skill of ['man', 'trap']) {
      for (const plugin of ['claude-code', 'codex']) {
        expect(read(`plugins/${plugin}/skills/${skill}/SKILL.md`).trimEnd().split('\n').length).toBeLessThan(100);
      }
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
      'README.md',
      'docs/man.md',
      'plugins/claude-code/README.md',
      'plugins/claude-code/skills/man/SKILL.md',
      'plugins/claude-code/skills/trap/SKILL.md',
      ...fs
        .readdirSync(`${root}/${commands}`)
        .filter((name) => name.endsWith('.md'))
        .map((name) => `${commands}/${name}`),
      ...fs
        .readdirSync(`${root}/apps/cli/src`)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => `apps/cli/src/${name}`),
    ];
    for (const file of files) {
      expect(read(file).match(/(?<![\w:./-])\/(?:helm|soak|stow|relieve|tend)\b/g), file).toBeNull();
    }
  });

  it('both plugins wire the same hook events and commands', () => {
    expect(sharedHooks(read('plugins/codex/hooks/hooks.json'))).toEqual(sharedHooks(read('plugins/claude-code/hooks/hooks.json')));
  });
});
