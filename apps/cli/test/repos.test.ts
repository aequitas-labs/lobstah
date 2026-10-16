import { afterEach, beforeEach, describe, expect, it as baseIt } from 'vitest';

// Real `git init`/`commit` per test — generous timeout so parallel-suite
// machine load can't flake it.
const it = (name: string, fn: () => void) => baseIt(name, { timeout: 30_000 }, fn);
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { appendRepoBlock, configuredRepoKeys, detectRepo, repoKeyFor, scanForRepos } from '../src/repos.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-repos-'));
});
afterEach(() => {
  removeTempDir(dir);
});

function makeRepo(name: string, opts: { origin?: string; lockfile?: string } = {}): string {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'trunk-branch']);
  if (opts.origin) execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', opts.origin]);
  if (opts.lockfile) fs.writeFileSync(path.join(repo, opts.lockfile), '');
  return repo;
}

describe('detectRepo', () => {
  it('reads origin, current branch, and lockfile-derived setup', () => {
    const repo = makeRepo('widgets', { origin: 'git@github.com:acme/widgets.git', lockfile: 'pnpm-lock.yaml' });
    const d = detectRepo(repo)!;
    expect(d.key).toBe('widgets');
    expect(d.origin).toBe('git@github.com:acme/widgets.git');
    expect(d.trunk).toBe('trunk-branch'); // no origin/HEAD in a fresh init — falls back to the checked-out branch
    expect(d.setup).toEqual(['pnpm install']);
  });

  it('takes a main branch over the checked-out feature branch when origin/HEAD is not set', () => {
    const repo = makeRepo('widgets');
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
    git('commit', '-q', '--allow-empty', '-m', 'init');
    git('branch', 'main');
    git('checkout', '-q', '-b', 'feature/x');
    expect(detectRepo(repo)!.trunk).toBe('main');
  });

  it('keys a dotted folder name with a dash', () => {
    expect(detectRepo(makeRepo('my.repo'))!.key).toBe('my-repo');
    expect(repoKeyFor('a b.c')).toBe('a-b-c');
  });

  it('returns undefined for a non-repo and for a subdirectory of a repo', () => {
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain);
    expect(detectRepo(plain)).toBeUndefined();
    const repo = makeRepo('widgets');
    const sub = path.join(repo, 'src');
    fs.mkdirSync(sub);
    expect(detectRepo(sub)).toBeUndefined();
  });
});

describe('scanForRepos', () => {
  it('finds repos one level under a root, skipping non-repos and dotdirs', () => {
    makeRepo('widgets');
    makeRepo('gadgets');
    fs.mkdirSync(path.join(dir, 'not-a-repo'));
    fs.mkdirSync(path.join(dir, '.hidden'));
    const found = scanForRepos([dir]);
    expect(found.map((r) => r.key).sort()).toEqual(['gadgets', 'widgets']);
  });

  it('treats a root that is itself a repo as one repo, not a container', () => {
    const repo = makeRepo('widgets');
    expect(scanForRepos([repo]).map((r) => r.key)).toEqual(['widgets']);
  });
});

describe('appendRepoBlock', () => {
  it('appends a parseable block without touching existing content', () => {
    const cfg = path.join(dir, 'config.toml');
    fs.writeFileSync(cfg, '# hand-written comment\nremindSecs = 300\n');
    appendRepoBlock(
      { key: 'widgets', path: '/tmp/widgets', trunk: 'main', origin: 'git@github.com:acme/widgets.git', setup: ['pnpm install'] },
      { pickup: true },
      cfg,
    );
    const raw = fs.readFileSync(cfg, 'utf8');
    expect(raw).toContain('# hand-written comment');
    const parsed = parse(raw) as { remindSecs: number; repos: Record<string, Record<string, unknown>> };
    expect(parsed.remindSecs).toBe(300);
    expect(parsed.repos.widgets).toMatchObject({
      path: '/tmp/widgets',
      trunk: 'main',
      origin: 'git@github.com:acme/widgets.git',
      setup: ['pnpm install'],
      pickup: true,
    });
    expect(configuredRepoKeys(cfg)).toEqual(new Set(['widgets']));
  });

  it('quotes a key that is not a bare TOML key, so it reads back as written', () => {
    const cfg = path.join(dir, 'config.toml');
    appendRepoBlock({ key: 'my.repo', path: '/tmp/my.repo', trunk: 'main' }, {}, cfg);
    expect(configuredRepoKeys(cfg)).toEqual(new Set(['my.repo']));
  });
});

describe('lobstah init', () => {
  const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const run = (home: string, ...args: string[]) => {
    const res = spawnSync(process.execPath, [cli, 'init', ...args], { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home }, timeout: 15_000 });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    return res.stdout;
  };

  it('a bare init writes no repo, and its [hooks.notify] example parses once uncommented', () => {
    const home = path.join(dir, 'home');
    run(home);
    const raw = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect((parse(raw) as { repos?: unknown }).repos).toBeUndefined();
    const enabled = raw.replace(/^# (\[hooks\.notify\])$/m, '$1').replace(/^# (command = .*)$/m, '$1');
    expect((parse(enabled) as { hooks: { notify: { command: string } } }).hooks.notify.command).toBe('ntfy pub my-topic "$LOBSTAH_VERB $LOBSTAH_ID: $LOBSTAH_NOTE"');
  });

  it('names a repo it skips because another repo has its key, and stays quiet on a rescan', () => {
    const home = path.join(dir, 'home');
    makeRepo(path.join('a', 'widgets'));
    makeRepo(path.join('b', 'widgets'));
    const out = run(home, '--scan', path.join(dir, 'a'), path.join(dir, 'b'));
    expect(out).toContain('added: widgets');
    expect(out).toMatch(/skipped: .*b[\\/]widgets \(key "widgets" is taken; lobstah repos add .* --key <other-name>\)/);
    expect(run(home, '--scan', path.join(dir, 'a'))).not.toContain('skipped');
  });

  it('a second scan of a dotted folder keeps the file valid', () => {
    const home = path.join(dir, 'home');
    makeRepo(path.join('src', 'my.repo'));
    expect(run(home, '--scan', path.join(dir, 'src'))).toContain('added: my-repo');
    run(home, '--scan', path.join(dir, 'src'));
    const parsed = parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')) as { repos: Record<string, unknown> };
    expect(Object.keys(parsed.repos)).toEqual(['my-repo']);
  });
});
