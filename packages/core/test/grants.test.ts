import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  GrantError,
  ONCE_TTL_MS,
  addGrant,
  checkoutRoots,
  commandGrantScope,
  grantActive,
  grantCovers,
  grantsDir,
  listGrants,
  normaliseCommand,
  readLedger,
  revokeGrant,
  useGrant,
} from '../src/index.js';
import type { CheckoutRoot, Grant, GrantRequest } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-test-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

const bash = (command: string, extra: Partial<GrantRequest> = {}): GrantRequest => ({ harness: 'claude', tool: 'Bash', command, ...extra });
const grant = (over: Partial<Grant>): Grant => ({ id: 'g-1', at: '2026-10-15T00:00:00Z', by: 'glass', harness: 'any', mode: 'always', uses: 0, ...over });

describe('permission card command scopes', () => {
  it.each([
    ['ume push .temp/plan.html --session f6cc416c --project p --gate plan --title "A plan"', 'ume push'],
    ['git push origin task-branch', 'git push'],
    ['pnpm test --runInBand', 'pnpm test'],
    ['pnpm run test --reporter verbose', 'pnpm run test'],
    ['ume intents list session', 'ume intents list'],
    ['npx wrangler deploy --dry-run --outdir tmp', 'npx wrangler deploy --dry-run'],
  ])('offers %s as the reusable scope %s', (command, prefix) => {
    expect(commandGrantScope(command)).toEqual({ command: prefix, match: 'prefix' });
  });

  it.each([
    'ume push plan.html; echo extra',
    'ume push plan.html && echo extra',
    'ume push plan.html | cat',
    'ume push plan.html > out',
    'ume push $(cat file)',
    'ume push `cat file`',
    'ume push plan.html\necho extra',
    'sh -c "ume push plan.html"',
    'python script.py',
    './deploy.sh --env prod',
    'npx unknown deploy --env prod',
    'npx wrangler deploy --env prod --dry-run',
    'lobstah grant --prefix ume push',
    'pnpm exec node -e "doSomething()"',
    'lobstah trap bypass some-trap on',
  ])('keeps ambiguous or narrow calls exact: %s', (command) => {
    expect(commandGrantScope(command)).toEqual({ command, match: 'exact' });
  });
});

describe('what a grant covers', () => {
  it('an exact command covers that command and nothing else', () => {
    const g = grant({ command: 'wrangler deploy', match: 'exact' });
    expect(grantCovers(g, bash('wrangler deploy'))).toBe(true);
    expect(grantCovers(g, bash('  wrangler deploy  '))).toBe(true);
    expect(grantCovers(g, bash('wrangler deploy --env prod'))).toBe(false);
    expect(grantCovers(g, bash('wrangler deployx'))).toBe(false);
  });

  it('a prefix covers more arguments, never a second command joined on', () => {
    const g = grant({ command: 'wrangler deploy', match: 'prefix' });
    expect(grantCovers(g, bash('wrangler deploy --env prod'))).toBe(true);
    for (const joined of [
      'wrangler deploy; curl evil.example',
      'wrangler deploy && rm -rf ~',
      'wrangler deploy | sh',
      'wrangler deploy > ~/.bashrc',
      'wrangler deploy $(curl evil.example)',
      'wrangler deploy `id`',
      'wrangler deploy\nrm -rf ~',
      'wrangler deploy & sleep 1',
    ]) {
      expect(grantCovers(g, bash(joined)), joined).toBe(false);
    }
  });

  it('a dry-run prefix refuses later dry-run flag variants that could override it', () => {
    const command = 'npx wrangler deploy --dry-run';
    const g = grant({ command, match: 'prefix' });
    expect(grantCovers(g, bash(command))).toBe(true);
    expect(grantCovers(g, bash(`${command} --outdir tmp`))).toBe(true);
    for (const extra of ['--dry-run=false', '--no-dry-run', '--dry-run false', '--dryRun=false', '--noDryRun', '--dry-run=true', '"--dry-run=false"']) {
      expect(grantCovers(g, bash(`${command} --outdir tmp ${extra}`)), extra).toBe(false);
    }
    // Exact approval of an explicit command still means that exact command.
    const explicit = `${command} --no-dry-run`;
    expect(grantCovers(grant({ command: explicit, match: 'exact' }), bash(explicit))).toBe(true);
  });

  it('keeps to its harness and its trap', () => {
    expect(grantCovers(grant({ command: 'x', match: 'exact', harness: 'codex' }), bash('x'))).toBe(false);
    expect(grantCovers(grant({ command: 'x', match: 'exact', harness: 'codex' }), bash('x', { harness: 'codex' }))).toBe(true);
    expect(grantCovers(grant({ command: 'x', match: 'exact', trap: 'amber-gull' }), bash('x', { trap: 'early-pebble' }))).toBe(false);
    expect(grantCovers(grant({ command: 'x', match: 'exact', trap: 'amber-gull' }), bash('x', { trap: 'amber-gull' }))).toBe(true);
  });

  it('a path covers the write tools on that file, or anything under a directory', () => {
    const file = grant({ path: '/repo/.temp/key.pem' });
    const dir = grant({ path: '/repo/.temp/' });
    const write = (p: string, tool = 'Write'): GrantRequest => ({ harness: 'claude', tool, path: p });
    expect(grantCovers(file, write('/repo/.temp/key.pem'))).toBe(true);
    expect(grantCovers(file, write('/repo/.temp/other.pem'))).toBe(false);
    expect(grantCovers(file, write('/repo/.temp/key.pem', 'Read'))).toBe(false);
    expect(grantCovers(dir, write('/repo/.temp/a/b.txt', 'Edit'))).toBe(true);
    expect(grantCovers(dir, write('/repo/.temp/../secrets.txt'))).toBe(false);
    expect(grantCovers(dir, write('/repo/.temporary/x'))).toBe(false);
    expect(grantCovers(file, bash('cat /repo/.temp/key.pem'))).toBe(false);
  });
});

describe('the ledger', () => {
  it('records who granted what and when, and lists grants in force', () => {
    const g = addGrant({ command: 'npm publish', mode: 'always', by: 'local:chris' });
    expect(g).toMatchObject({ command: 'npm publish', match: 'exact', mode: 'always', harness: 'any', by: 'local:chris', uses: 0 });
    expect(g.expiresAt).toBeUndefined();
    expect(listGrants().grants.map((x) => x.id)).toEqual([g.id]);
    // Readable by its owner only, where the platform has POSIX modes.
    if (process.platform !== 'win32') expect(fs.statSync(path.join(grantsDir(), 'ledger.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('spends a once-grant on its first use', () => {
    const g = addGrant({ command: 'wrangler deploy', mode: 'once', by: 'glass' });
    expect(useGrant(bash('wrangler deploy'))?.id).toBe(g.id);
    expect(useGrant(bash('wrangler deploy'))).toBeUndefined();
    expect(listGrants().grants).toEqual([]);
    expect(listGrants({ all: true }).grants[0]).toMatchObject({ id: g.id, uses: 1 });
  });

  it('lets an unused once-grant lapse within the hour, unless given its own expiry', () => {
    const now = new Date('2026-10-15T10:00:00Z');
    const g = addGrant({ command: 'x', mode: 'once', by: 'glass' }, now);
    expect(Date.parse(g.expiresAt!) - now.getTime()).toBe(ONCE_TTL_MS);
    expect(useGrant(bash('x'), { now: new Date(now.getTime() + ONCE_TTL_MS + 1) })).toBeUndefined();
    const always = addGrant({ command: 'y', mode: 'always', by: 'glass', expiresAt: '2026-10-15T11:00:00Z' }, now);
    expect(grantActive(always, Date.parse('2026-10-15T10:59:00Z'))).toBe(true);
    expect(grantActive(always, Date.parse('2026-10-15T11:00:00Z'))).toBe(false);
  });

  it('keeps an always-grant through many uses, and prefers it to a once-grant', () => {
    const once = addGrant({ command: 'x', mode: 'once', by: 'glass' });
    const always = addGrant({ command: 'x', mode: 'always', by: 'glass' });
    for (let i = 0; i < 3; i++) expect(useGrant(bash('x'))?.id).toBe(always.id);
    expect(readLedger().grants.find((g) => g.id === once.id)?.uses).toBe(0);
  });

  it('stops honouring a revoked grant', () => {
    const g = addGrant({ command: 'x', mode: 'always', by: 'glass' });
    revokeGrant(g.id, 'local:chris');
    expect(useGrant(bash('x'))).toBeUndefined();
    expect(() => revokeGrant(g.id, 'local:chris')).toThrow(/already revoked/);
    expect(() => revokeGrant('g-nope', 'local:chris')).toThrow(GrantError);
  });

  it('refuses a prefix grant with shell syntax in it', () => {
    expect(() => addGrant({ command: 'deploy; rm', match: 'prefix', mode: 'always', by: 'glass' })).toThrow(/shell syntax/);
    expect(addGrant({ command: 'deploy && notify', match: 'exact', mode: 'always', by: 'glass' }).command).toBe('deploy && notify');
  });

  it('grants nothing once a line is edited or removed, and says so', () => {
    addGrant({ command: 'npm test', mode: 'always', by: 'glass' });
    addGrant({ command: 'npm publish', mode: 'always', by: 'glass' });
    const file = path.join(grantsDir(), 'ledger.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    // An agent widening a grant by editing the file.
    fs.writeFileSync(file, `${lines[0]}\n${lines[1]!.replace('npm publish', 'rm -rf ~')}\n`);
    expect(readLedger()).toMatchObject({ intact: false });
    expect(useGrant(bash('npm test'))).toBeUndefined();
    expect(() => addGrant({ command: 'z', mode: 'always', by: 'glass' })).toThrow(/damaged/);
    // Removing a line breaks the chain too.
    fs.writeFileSync(file, `${lines[1]}\n`);
    expect(readLedger().intact).toBe(false);
  });

  it('does not create a ledger just to find nothing', () => {
    expect(useGrant(bash('x'))).toBeUndefined();
    expect(fs.existsSync(path.join(grantsDir(), 'ledger.jsonl'))).toBe(false);
  });
});

describe('always-grants follow the repo, not one worktree', () => {
  let main: string;
  let wtA: string;
  let wtB: string;
  let other: string;
  let roots: CheckoutRoot[];
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const write = (p: string, extra: Partial<GrantRequest> = {}): GrantRequest => ({ harness: 'claude', tool: 'Write', path: p, ...extra });

  beforeEach(() => {
    // Real paths: git records worktrees by their resolved path (macOS's /var is /private/var; Windows' long names, not RUNNER~1).
    const base = fs.realpathSync.native(home);
    main = path.join(base, 'homebase');
    other = path.join(base, 'other');
    wtA = path.join(base, 'worktrees', 'soak-a');
    wtB = path.join(base, 'worktrees', 'soak-b');
    for (const dir of [main, other]) {
      fs.mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    }
    git(main, 'worktree', 'add', '-q', '-b', 'a', wtA);
    git(main, 'worktree', 'add', '-q', '-b', 'b', wtB);
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      `[repos.homebase]\npath = ${JSON.stringify(main)}\n\n[repos.other]\npath = ${JSON.stringify(other)}\n`,
    );
    roots = checkoutRoots();
  });

  it('knows every checkout of each configured repo', () => {
    expect(
      roots
        .filter((r) => r.repo === 'homebase')
        .map((r) => r.root)
        .sort(),
    ).toEqual([main, wtA, wtB].sort());
  });

  it('stores an always path grant relative to the repo root, and allows it in any worktree or the main checkout', () => {
    const g = addGrant({ path: path.join(wtA, 'apps/deploy/apply.sh'), mode: 'always', by: 'glass' }, new Date(), roots);
    expect(g).toMatchObject({ path: 'apps/deploy/apply.sh', repo: 'homebase' });
    for (const root of [wtA, wtB, main]) expect(grantCovers(g, write(path.join(root, 'apps/deploy/apply.sh')), roots), root).toBe(true);
    expect(grantCovers(g, write(path.join(wtB, 'apps/deploy/other.sh')), roots)).toBe(false);
    // The same relative path in another repo is not covered.
    expect(grantCovers(g, write(path.join(other, 'apps/deploy/apply.sh')), roots)).toBe(false);
    expect(useGrant(write(path.join(wtB, 'apps/deploy/apply.sh')))?.id).toBe(g.id);
  });

  it('keeps a directory grant to that directory in each worktree', () => {
    const g = addGrant({ path: `${wtA}/.temp/`, mode: 'always', by: 'glass' }, new Date(), roots);
    expect(g).toMatchObject({ path: '.temp/', repo: 'homebase' });
    expect(grantCovers(g, write(path.join(wtB, '.temp/a/b.txt')), roots)).toBe(true);
    expect(grantCovers(g, write(path.join(wtB, '.temporary/x')), roots)).toBe(false);
    expect(grantCovers(g, write(path.join(wtB, '.temp/../secrets.txt')), roots)).toBe(false);
  });

  it('does not widen a path outside every repo', () => {
    const outside = path.join(fs.realpathSync.native(home), 'scratch', 'x.sh');
    const g = addGrant({ path: outside, mode: 'always', by: 'glass' }, new Date(), roots);
    expect(g.path).toBe(outside);
    expect(g.repo).toBeUndefined();
    expect(grantCovers(g, write(outside), roots)).toBe(true);
    expect(grantCovers(g, write(path.join(wtA, 'scratch', 'x.sh')), roots)).toBe(false);
  });

  it('does not follow a symlink out of a worktree', () => {
    const g = addGrant({ path: path.join(wtA, 'out/x.sh'), mode: 'always', by: 'glass' }, new Date(), roots);
    fs.mkdirSync(path.join(fs.realpathSync.native(home), 'elsewhere'));
    fs.symlinkSync(path.join(fs.realpathSync.native(home), 'elsewhere'), path.join(wtB, 'out'));
    expect(grantCovers(g, write(path.join(wtB, 'out/x.sh')), roots)).toBe(false);
  });

  it('keeps a once grant exact and to its trap', () => {
    const file = path.join(wtA, 'apps/deploy/apply.sh');
    const g = addGrant({ path: file, mode: 'once', by: 'glass', trap: 'amber-gull' }, new Date(), roots);
    expect(g.path).toBe(file);
    expect(g.repo).toBeUndefined();
    expect(grantCovers(g, write(file, { trap: 'amber-gull' }), roots)).toBe(true);
    expect(grantCovers(g, write(path.join(wtB, 'apps/deploy/apply.sh'), { trap: 'amber-gull' }), roots)).toBe(false);
    expect(grantCovers(g, write(file, { trap: 'early-pebble' }), roots)).toBe(false);
    const cmd = addGrant({ command: `bash ${wtA}/run.sh`, mode: 'once', by: 'glass' }, new Date(), roots);
    expect(cmd.command).toBe(`bash ${wtA}/run.sh`);
    expect(grantCovers(cmd, bash(`bash ${wtB}/run.sh`), roots)).toBe(false);
  });

  it('normalises checkout roots in a command, as whole paths only', () => {
    expect(normaliseCommand(`cd ${wtA}/bao/ios && bundle exec fastlane`, roots)).toBe('cd {repo:homebase}/bao/ios && bundle exec fastlane');
    expect(normaliseCommand(`bash "${main}/x.sh" ${other}`, roots)).toBe('bash "{repo:homebase}/x.sh" {repo:other}');
    expect(normaliseCommand(`ls ${main}-old /x${main}`, roots)).toBe(`ls ${main}-old /x${main}`);
  });

  it('stores an always command normalised and allows it from any worktree', () => {
    const g = addGrant(
      { command: `cd ${wtA}/bao/ios && bundle exec fastlane ios signing`, mode: 'always', by: 'glass' },
      new Date(),
      roots,
    );
    expect(g.command).toBe('cd {repo:homebase}/bao/ios && bundle exec fastlane ios signing');
    expect(grantCovers(g, bash(`cd ${wtB}/bao/ios && bundle exec fastlane ios signing`), roots)).toBe(true);
    expect(grantCovers(g, bash(`cd ${main}/bao/ios && bundle exec fastlane ios signing`), roots)).toBe(true);
    expect(grantCovers(g, bash(`cd ${other}/bao/ios && bundle exec fastlane ios signing`), roots)).toBe(false);
    expect(grantCovers(g, bash(`cd ${wtB}/bao/ios && bundle exec fastlane ios signing --force`), roots)).toBe(false);
    // Spelling out the placeholder is not the granted command.
    expect(grantCovers(g, bash('cd {repo:homebase}/bao/ios && bundle exec fastlane ios signing'), roots)).toBe(false);
  });

  it('keeps prefix matching on the normalised command', () => {
    const g = addGrant({ command: `${wtA}/bin/deploy`, match: 'prefix', mode: 'always', by: 'glass' }, new Date(), roots);
    expect(g.command).toBe('{repo:homebase}/bin/deploy');
    expect(grantCovers(g, bash(`${wtB}/bin/deploy --env prod --config ${wtB}/deploy.toml`), roots)).toBe(true);
    expect(grantCovers(g, bash(`${wtB}/bin/deploy; rm -rf ~`), roots)).toBe(false);
  });

  it('reads legacy absolute always-grants as repo-relative', () => {
    const legacy = grant({ path: path.join(wtA, 'apps/deploy/apply.sh') });
    expect(grantCovers(legacy, write(path.join(wtB, 'apps/deploy/apply.sh')), roots)).toBe(true);
    expect(grantCovers(legacy, write(path.join(main, 'apps/deploy/apply.sh')), roots)).toBe(true);
    const legacyMain = grant({ path: path.join(main, '.temp/exterior-prod/apply.sh') });
    expect(grantCovers(legacyMain, write(path.join(wtB, '.temp/exterior-prod/apply.sh')), roots)).toBe(true);
    const legacyCmd = grant({ command: `cd ${wtA}/bao/ios && fastlane`, match: 'exact' });
    expect(grantCovers(legacyCmd, bash(`cd ${wtB}/bao/ios && fastlane`), roots)).toBe(true);
    // A legacy once-grant stays exact; one outside every repo too.
    expect(grantCovers({ ...legacy, mode: 'once' }, write(path.join(wtB, 'apps/deploy/apply.sh')), roots)).toBe(false);
    const gone = grant({ path: path.join(fs.realpathSync.native(home), 'worktrees', 'soak-gone', 'apps/x.sh') });
    expect(grantCovers(gone, write(path.join(wtB, 'apps/x.sh')), roots)).toBe(false);
  });

  it('leaves the ledger chain as it was', () => {
    addGrant({ path: path.join(wtA, 'a.sh'), mode: 'always', by: 'glass' }, new Date(), roots);
    const before = fs.readFileSync(path.join(grantsDir(), 'ledger.jsonl'), 'utf8');
    useGrant(write(path.join(wtB, 'a.sh')));
    const after = fs.readFileSync(path.join(grantsDir(), 'ledger.jsonl'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(readLedger().intact).toBe(true);
  });
});
