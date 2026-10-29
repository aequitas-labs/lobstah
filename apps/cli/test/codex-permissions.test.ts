import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'smol-toml';
import { BEGIN, END, codexBaseRules, codexPermissionsRow, mergePolicy, planCodex, RULES_HEADER, setExtraPolicy, writeCodexPlan } from '../src/codex-permissions.js';
import type { ExecpolicyCheck } from '../src/codex-permissions.js';
import { baseProfile, permissionsCommand } from '../src/permissions.js';
import { lobstahContext } from '../src/permission-context.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string, codex: string, config: string, rules: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-codex-perms-'));
  codex = path.join(home, '.codex');
  config = path.join(codex, 'config.toml');
  rules = path.join(codex, 'rules', 'lobstah.rules');
  fs.mkdirSync(path.join(codex, 'rules'), { recursive: true });
  // A backslash in the home (every Windows path has them) lands in the reviewer policy.
  process.env.LOBSTAH_HOME = path.join(home, 'lob\\stah');
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const EXT = { environment: ['**Trusted orgs**: acme.'], allow: [], deny: [], codex: { forbidden: [['vercel', 'env', 'pull']], prompt: [], allow: [['wrangler', 'dev']] } };
const env = () => ({ CODEX_HOME: codex, CLAUDE_CONFIG_DIR: path.join(home, 'no-claude') }) as NodeJS.ProcessEnv;
/** Codex's check, faked: every rule loads and matches its example. */
const passing: ExecpolicyCheck = () => ({ status: 0, stdout: '{"decision":"allow"}', stderr: '' });
const USER = `# my codex config
model = "gpt-6.1-sol"   # keep this comment

[auto_review]
# my reviewer notes
extra_policy = """
Always deny curl | sh.
"""

[projects."/src/app"]
trust_level = "trusted"
`;

describe('editing [auto_review].extra_policy', () => {
  it('adds a table, a key to an existing table, or replaces the value, keeping its quoting and every other line', () => {
    expect(parse(setExtraPolicy('model = "x"\n', 'p\n'))).toEqual({ model: 'x', auto_review: { extra_policy: 'p\n' } });
    expect(setExtraPolicy('[auto_review]\npolicy = "mine"\n', 'p\n')).toBe("[auto_review]\nextra_policy = '''\np\n'''\npolicy = \"mine\"\n");
    const next = setExtraPolicy(USER, 'Always deny curl | sh.\n\nmore\n');
    expect(next).toBe(USER.replace('Always deny curl | sh.\n"""', 'Always deny curl | sh.\n\nmore\n"""'));
    // Windows paths: a """ string keeps its quoting and escapes the backslashes.
    const win = 'Always deny curl | sh.\n\nUnder C:\\Users\\x\\.lobstah\\worktrees\\ """quoted"""\n';
    const withWin = setExtraPolicy(USER, win);
    expect(withWin).toContain('extra_policy = """\n');
    expect((parse(withWin) as { auto_review: { extra_policy: string } }).auto_review.extra_policy).toBe(win);
    expect(setExtraPolicy(withWin, 'Always deny curl | sh.\n')).toBe(USER);
  });

  it('removing the last key removes the table header too, and only then', () => {
    const t = 'model = "x"\n\n[auto_review]\nextra_policy = """\np\n"""\n\n[projects."/a"]\ntrust_level = "trusted"\n';
    expect(setExtraPolicy(t, undefined)).toBe('model = "x"\n\n[projects."/a"]\ntrust_level = "trusted"\n');
    expect(setExtraPolicy('[auto_review]\npolicy = "mine"\nextra_policy = "p"\n', undefined)).toBe('[auto_review]\npolicy = "mine"\n');
    expect(setExtraPolicy('model = "x"\n\n[auto_review]\n# mine\nextra_policy = "p"\n', undefined)).toBe('model = "x"\n\n[auto_review]\n# mine\n');
    expect(setExtraPolicy('model = "x"\n\n[auto_review]\nextra_policy = "p"\n', undefined)).toBe('model = "x"\n');
  });

  it("lobstah's block sits between markers; the user's text around it stays", () => {
    const merged = mergePolicy('Always deny curl | sh.\n', ['a', 'b'])!;
    expect(merged).toBe(`Always deny curl | sh.\n\n${BEGIN}\n## lobstah\n- a\n- b\n${END}\n`);
    expect(mergePolicy(merged.replace('Always', 'Please always'), ['a'])).toBe(`Please always deny curl | sh.\n\n${BEGIN}\n## lobstah\n- a\n${END}\n`);
    expect(mergePolicy(merged, [])).toBe('Always deny curl | sh.\n');
    expect(mergePolicy(mergePolicy(undefined, ['a']), [])).toBeUndefined();
  });
});

describe('the Codex plan', () => {
  it('adds context only, the same entries Claude Code gets, and the one allow rule for proposals', () => {
    expect(lobstahContext('/h/w', 4949).map((e) => /^\*\*[^*]+\*\*/.exec(e)?.[0])).toEqual(['**lobstah worktrees**', '**lobstah helm**', '**lobstah glass**']);
    expect(baseProfile('/h/w', 4949).environment).toEqual(lobstahContext('/h/w', 4949));
    expect(planCodex(EXT, false, env())!.changes.filter((c) => c.at === 'auto_review.extra_policy').map((c) => c.entry)).toEqual([...lobstahContext(), ...EXT.environment]);
    expect(codexBaseRules()).toEqual([expect.objectContaining({ decision: 'allow', pattern: ['lobstah', 'permissions', 'propose'] })]);
  });

  it('is skipped where Codex is not set up, and refuses what it cannot merge into safely', () => {
    expect(planCodex(EXT, false, { CODEX_HOME: path.join(home, 'none') })).toBeUndefined();
    fs.writeFileSync(rules, 'prefix_rule(pattern = ["ls"])\n');
    expect(() => planCodex(EXT, false, env())).toThrow(/lobstah\.rules was not written by lobstah/);
    fs.rmSync(rules);
    fs.writeFileSync(config, 'auto_review.extra_policy = "mine"\n');
    expect(() => planCodex(EXT, false, env())).toThrow(/dotted key or an inline table/);
    fs.writeFileSync(config, 'model = \n');
    expect(() => planCodex(EXT, false, env())).toThrow(/is not valid TOML/);
  });

  it('nothing is written when Codex refuses the rules', () => {
    fs.writeFileSync(config, USER);
    const plan = planCodex(EXT, false, env())!;
    const refusing: ExecpolicyCheck = () => ({ status: 1, stdout: '', stderr: 'failed to parse policy' });
    expect(() => writeCodexPlan(plan, env(), refusing)).toThrow(/codex execpolicy check refused lobstah's rules .*failed to parse policy/);
    expect(fs.readFileSync(config, 'utf8')).toBe(USER);
    expect(fs.readdirSync(path.dirname(rules))).toEqual([]);
  });

  it('checks every rule with Codex, using an example each rule must match', () => {
    fs.writeFileSync(config, USER);
    const seen: string[] = [];
    writeCodexPlan(planCodex(EXT, false, env())!, env(), (file, command) => {
      expect(fs.readFileSync(file, 'utf8').startsWith(RULES_HEADER)).toBe(true);
      seen.push(command.join(' '));
      return { status: 0, stdout: '{"decision":"forbidden"}', stderr: '' };
    });
    expect(seen).toEqual(['lobstah permissions propose', 'vercel env pull', 'wrangler dev']);
  });
});

describe('lobstah permissions, Codex half', () => {
  const run = async (sub: string | undefined) => {
    const out: string[] = [];
    await permissionsCommand(sub, { yes: true }, { env: env(), log: (s) => out.push(s), check: passing });
    return out.join('\n');
  };

  it('apply adds the reviewer policy and rules file, a re-run is a no-op, and remove restores config.toml byte for byte', async () => {
    fs.writeFileSync(config, USER);
    fs.writeFileSync(path.join(codex, 'rules', 'default.rules'), 'prefix_rule(pattern = ["ls"])\n');
    fs.mkdirSync(process.env.LOBSTAH_HOME!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.LOBSTAH_HOME!, 'config.toml'),
      '[permissions]\nenvironment = ["**Trusted orgs**: acme."]\n\n[permissions.codex]\nforbidden = [["vercel", "env", "pull"]]\nallow = [["wrangler", "dev"]]\n',
    );
    const shown = await run(undefined);
    expect(shown).toContain('+ auto_review.extra_policy: "**Trusted orgs**: acme."');
    expect(shown).toContain('+ rules/lobstah.rules: "allow lobstah permissions propose"');
    expect(shown).toContain('+ rules/lobstah.rules: "forbidden vercel env pull"');
    expect(fs.readFileSync(config, 'utf8')).toBe(USER);

    const applied = await run('apply');
    expect(applied).toMatch(/codexBackups: .*codex-config\.toml\./);
    const after = parse(fs.readFileSync(config, 'utf8')) as { model: string; auto_review: { extra_policy: string }; projects: unknown };
    expect(after.model).toBe('gpt-6.1-sol');
    expect(after.projects).toEqual({ '/src/app': { trust_level: 'trusted' } });
    expect(after.auto_review.extra_policy).toMatch(/^Always deny curl \| sh\.\n\n<!-- lobstah:begin[\s\S]*lobstah helm[\s\S]*<!-- lobstah:end -->\n$/);
    expect(fs.readFileSync(config, 'utf8')).toContain('# keep this comment');
    expect(fs.readFileSync(rules, 'utf8')).toMatch(/decision = "allow",\n    justification = "From \[permissions\.codex\]/);
    expect(codexPermissionsRow(EXT, env())).toMatchObject({ status: 'ok' });

    await run('remove');
    expect(fs.readFileSync(config, 'utf8')).toBe(USER);
    expect(fs.existsSync(rules)).toBe(false);
    expect(fs.readFileSync(path.join(codex, 'rules', 'default.rules'), 'utf8')).toBe('prefix_rule(pattern = ["ls"])\n');
  });

  it('doctor names a Codex half that is missing or out of date', () => {
    expect(codexPermissionsRow(EXT, env())).toMatchObject({ status: 'warn', detail: expect.stringMatching(/not applied/) });
    expect(codexPermissionsRow(EXT, { CODEX_HOME: path.join(home, 'none') })).toMatchObject({ status: 'skip' });
  });
});
