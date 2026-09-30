import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BRIEF_KINDS, loadConfig, withBriefHooks } from '../src/index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-brief-hooks-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('[repos.<key>.briefHooks]', () => {
  it('each kind gets its own text, then the all text; a repo with none is unchanged', () => {
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      [
        '[repos.web]',
        'path = "/w"',
        '[repos.web.briefHooks]',
        ...BRIEF_KINDS.map((k) => `${k} = "Then run the ${k} step."`),
        'all = """',
        'Finally, run /pr-refresh.',
        '"""',
        'unknown = "ignored"',
        '[repos.api]',
        'path = "/a"',
        '[repos.api.briefHooks]',
        'checks = "   "',
      ].join('\n'),
    );
    const cfg = loadConfig();
    expect(cfg.repos.web!.briefHooks).toEqual({
      ...Object.fromEntries(BRIEF_KINDS.map((k) => [k, `Then run the ${k} step.`])),
      all: 'Finally, run /pr-refresh.',
    });
    for (const kind of BRIEF_KINDS) {
      expect(withBriefHooks('Repair it. Push.', cfg.repos.web, kind)).toBe(`Repair it. Push.\n\nThen run the ${kind} step.\n\nFinally, run /pr-refresh.`);
    }
    // A blank hook is none; an unknown key is ignored.
    expect(cfg.repos.api!.briefHooks).toBeUndefined();
    expect(withBriefHooks('Repair it. Push.', cfg.repos.api, 'checks')).toBe('Repair it. Push.');
    expect(withBriefHooks('Repair it. Push.', undefined, 'rebase')).toBe('Repair it. Push.');
  });

  it('all alone applies to every kind', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[repos.web]\npath = "/w"\n[repos.web.briefHooks]\nall = "Run the repo refresh."\n');
    const web = loadConfig().repos.web;
    for (const kind of BRIEF_KINDS) expect(withBriefHooks('B', web, kind)).toBe('B\n\nRun the repo refresh.');
  });
});
