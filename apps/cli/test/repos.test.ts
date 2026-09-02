import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { appendRepoBlock, configuredRepoKeys, detectRepo, scanForRepos } from '../src/repos.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-repos-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
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
});
