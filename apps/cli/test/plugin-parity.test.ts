import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p: string) => fs.readFileSync(`${root}/${p}`, 'utf8').replace(/\r\n/g, '\n');

function skillMetadata(raw: string): { name: string; description: string } {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!frontmatter) throw new Error('missing skill frontmatter');
  const fields = new Map<string, string>();
  for (const line of frontmatter[1]!.split('\n')) {
    if (!line.trim()) continue;
    const field = /^([a-z][a-z0-9-]*):\s+(.+)$/.exec(line);
    if (!field || fields.has(field[1]!)) throw new Error(`invalid skill frontmatter line: ${line}`);
    fields.set(field[1]!, field[2]!.trim());
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) throw new Error('skill frontmatter requires name and description');
  return { name, description };
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
  it.each(['man', 'trap'])('the %s skill shares frontmatter in both plugins', (skill) => {
    const frontmatter = (raw: string) => raw.match(/^---\n[\s\S]*?\n---/)?.[0];
    expect(frontmatter(read(`plugins/codex/skills/${skill}/SKILL.md`))).toBe(
      frontmatter(read(`plugins/claude-code/skills/${skill}/SKILL.md`)),
    );
  });

  it.each([
    ['claude-code', 'man'],
    ['claude-code', 'trap'],
    ['codex', 'man'],
    ['codex', 'trap'],
  ])('validates the %s %s skill', (plugin, skill) => {
    const metadata = skillMetadata(read(`plugins/${plugin}/skills/${skill}/SKILL.md`));
    expect(metadata.name).toBe(skill);
    expect(metadata.description).toMatch(/\S/);
  });

  it('names the orchestrator skill man in both plugins', () => {
    for (const plugin of ['codex', 'claude-code']) {
      expect(read(`plugins/${plugin}/skills/man/SKILL.md`)).toMatch(/^---\nname: man\n/);
      expect(fs.existsSync(`${root}/plugins/${plugin}/skills/lobsterman/SKILL.md`)).toBe(false);
    }
    expect(fs.existsSync(`${root}/docs/lobsterman.md`)).toBe(false);
  });

  it('each plugin ships its own README for the registry listing', () => {
    // Split on purpose: the listings differ per harness (the /lobstah
    // command, Codex's trust review) — only presence is enforced.
    expect(read('plugins/codex/README.md')).toContain('lobstah for Codex');
    expect(read('plugins/claude-code/README.md')).toContain('lobstah for Claude Code');
  });

  it('the Codex listing keeps presentation fields under interface and ships both icons', () => {
    const manifest = JSON.parse(read('plugins/codex/.codex-plugin/plugin.json'));
    for (const field of ['displayName', 'shortDescription', 'websiteURL', 'composerIcon', 'logo']) {
      expect(manifest).not.toHaveProperty(field);
      expect(manifest.interface[field]).toEqual(expect.any(String));
    }
    for (const field of ['composerIcon', 'logo']) {
      const asset = manifest.interface[field];
      expect(asset).toBe('./assets/icon.png');
      expect(fs.existsSync(`${root}/plugins/codex/${asset}`), field).toBe(true);
      expect(fs.statSync(`${root}/plugins/codex/${asset}`).isFile(), field).toBe(true);
    }
  });

  it('both plugins expose the same four skills and no commands; Claude mentions are namespaced', () => {
    for (const plugin of ['claude-code', 'codex']) {
      expect(fs.existsSync(`${root}/plugins/${plugin}/commands`), plugin).toBe(false);
      expect(fs.readdirSync(`${root}/plugins/${plugin}/skills`).sort(), plugin).toEqual(['man', 'relieve', 'stow', 'trap']);
    }
    const skills = 'plugins/claude-code/skills';
    const files = [
      'README.md',
      'docs/man.md',
      'plugins/claude-code/README.md',
      ...fs.readdirSync(`${root}/${skills}`).map((name) => `${skills}/${name}/SKILL.md`),
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
